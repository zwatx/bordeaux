// Reference implementation of the brushed/BLDC DC-motor model from Greg McKaskle's
// LabVIEW motor-sim ("Getting serious with Motors"), applied to a swerve drivetrain.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Research aid only: it is not imported by Bordeaux. Run: node motor-envelope.mjs
//
// motor-sim derivation (Compute Motor Model Values.vi, 12 V reference):
//   R  = 12 / stallCurrent
//   Kt = stallTorque / stallCurrent
//   Kv = freeSpeed(rad/s) / (12 - freeCurrent * R)
// motor-sim instantaneous current/torque (Compute Motor Values.vi):
//   I  = clamp((V - w / Kv) / R - freeCurrent, -limit, +limit)
//   tau = Kt * I
// motor-sim drivetrain (Apply Torque to Drivebase.vi): wheel force is capped by mu*m*g.
// motor-sim battery (Battery.vi): Vbus = V0 - Itotal * Rinternal; brownout below 6.3 V.

export const MOTORS = {
  // name: [stallTorqueNm, stallCurrentA, freeRpm, freeCurrentA]
  // Values in motor-sim's Lookup Motor Coefficients.vi (2021):
  'neo (motor-sim 2021)': [3.36, 166, 5880, 1.3],
  'falcon-500': [4.69, 257, 6380, 1.5],
  // Current vendor figures (not in motor-sim):
  'neo (REV current)': [2.6, 105, 5676, 1.8],
  'rev-vortex': [3.6, 211, 6784, 3.6],
  'kraken-x60': [7.09, 366, 6000, 2.0],
  'kraken-x60-foc': [9.37, 483, 5800, 2.0],
};

export function motorModel([stallTorque, stallCurrent, freeRpm, freeCurrent], vRef = 12) {
  const R = vRef / stallCurrent;
  const Kt = stallTorque / stallCurrent;
  const wFree = (freeRpm * 2 * Math.PI) / 60;
  const Kv = wFree / (vRef - freeCurrent * R);
  return { R, Kt, Kv, freeCurrent, stallTorque, wFree };
}

// Torque-producing current at motor speed w (rad/s) with applied voltage V, limited by
// a stator current limit. Sign: positive accelerates in the direction of w.
export function motorCurrent(m, V, w, limit) {
  const raw = (V - w / m.Kv) / m.R - m.freeCurrent;
  return Math.max(-limit, Math.min(limit, raw));
}

// Maximum straight-line acceleration and deceleration (m/s^2) at robot speed v, with all
// drive motors commanded the same way (the motor-sim "drag race" case).
export function envelopeAt(v, robot, opts) {
  const m = motorModel(opts.motor);
  const r = robot.wheelDiameterM / 2;
  const w = (v / r) * robot.gearRatio; // motor rad/s
  const traction = robot.wheelFrictionCoefficient * robot.massKg * 9.80665;
  const forceFrom = (I) => (robot.motorCount * m.Kt * I * robot.gearRatio * opts.efficiency) / r;

  // Battery sag: Vbus = V0 - Rbat * (drive supply current + other loads), solved by bisection.
  // Supply current = (stator current incl. free current) * duty by power balance. When the
  // stator limit binds, the controller only needs duty = Vmotor / Vbus < 1, so a stator-limited
  // launch draws far less battery current than its stator current.
  const atBus = (vb) => {
    const I = motorCurrent(m, vb, w, opts.statorLimitA);
    const vMotor = (I + m.freeCurrent) * m.R + w / m.Kv;
    const duty = Math.max(0, Math.min(1, vMotor / vb));
    const supply = Math.min((I + m.freeCurrent) * duty, opts.supplyLimitA ?? Infinity);
    return { I, supply };
  };
  let lo = 0.1;
  let hi = opts.batteryV;
  for (let k = 0; k < 60; k += 1) {
    const mid = (lo + hi) / 2;
    const drop = opts.batteryR * (robot.motorCount * atBus(mid).supply + (opts.otherLoadA ?? 0));
    if (mid > opts.batteryV - drop) hi = mid;
    else lo = mid;
  }
  const vbus = lo;
  let { I } = atBus(vbus);
  // A supply limit caps battery current; translate it back to stator current at this duty.
  if (opts.supplyLimitA !== undefined) {
    const vMotorMax = vbus;
    const pStator = (I + m.freeCurrent) * ((I + m.freeCurrent) * m.R + w / m.Kv);
    if (pStator > opts.supplyLimitA * vMotorMax) {
      // Solve (I+If)^2 R + (I+If) w/Kv = Ilim * Vbus for I+If.
      const a = m.R;
      const b = w / m.Kv;
      const c = -opts.supplyLimitA * vbus;
      I = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a) - m.freeCurrent;
    }
  }
  const accelForce = Math.min(forceFrom(I), traction);

  // Braking: command -V. Back-EMF adds to the applied voltage, so the current limit (or
  // traction) is what binds. Regenerated supply current is ignored (it raises Vbus).
  const Ib = motorCurrent(m, -opts.batteryV, w, opts.statorLimitA);
  const decelForce = Math.min(Math.abs(forceFrom(Ib)), traction);

  const lossForce = opts.rollingResistanceN ?? 0;
  return {
    v,
    accel: Math.max(0, (accelForce - lossForce) / robot.massKg),
    decel: (decelForce + lossForce) / robot.massKg,
    vbus,
    statorA: I,
    tractionLimited: forceFrom(I) >= traction,
  };
}

// Bordeaux-style constant-torque cap for comparison: F = N * tauMax * G / r, capped by traction.
export function constantTorqueAccel(robot) {
  const r = robot.wheelDiameterM / 2;
  const f = (robot.motorCount * robot.motorMaxTorqueNm * robot.gearRatio) / r;
  return Math.min(f, robot.wheelFrictionCoefficient * robot.massKg * 9.80665) / robot.massKg;
}

// Time and distance to reach v from rest along the envelope (forward Euler, 1 ms).
export function dragRace(robot, opts, targetV, maxT = 5) {
  let v = 0;
  let x = 0;
  let t = 0;
  const dt = 0.001;
  while (v < targetV && t < maxT) {
    const a = envelopeAt(v, robot, opts).accel;
    if (a <= 1e-6) break;
    v += a * dt;
    x += v * dt;
    t += dt;
  }
  return { t, x, v };
}

// Bordeaux today (src/shared/robotLimits.ts + reachability.ts): a(v) = min(mu*g,
// N*tauStall*G/(r*m) * (1 - v/vFree)) when accelerating; braking is capped by mu*g only.
export function bordeauxEnvelopeAt(v, robot) {
  const r = robot.wheelDiameterM / 2;
  const vFree = (robot.motorFreeRpm / 60) * Math.PI * robot.wheelDiameterM / robot.gearRatio;
  const traction = robot.wheelFrictionCoefficient * 9.80665;
  const motor = (robot.motorCount * robot.motorMaxTorqueNm * robot.gearRatio) / (r * robot.massKg);
  return { accel: Math.min(traction, Math.max(0, motor * (1 - v / vFree))), decel: traction };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const motorName = process.argv[2] ?? 'rev-vortex';
  const motor = MOTORS[motorName];
  if (!motor) throw new Error(`unknown motor ${motorName}; choose one of ${Object.keys(MOTORS).join(', ')}`);
  // rebuilt-68 driveModel from Support Code/rebuilt-68/.bordeaux-workspace.json (2026-10-24),
  // with stall torque and free speed taken from the chosen motor.
  const robot = {
    motorCount: 4,
    gearRatio: 5.5,
    wheelDiameterM: 0.0762,
    massKg: 54.4310844,
    wheelFrictionCoefficient: 1.2,
    motorMaxTorqueNm: motor[0],
    motorFreeRpm: motor[2],
  };
  const r = robot.wheelDiameterM / 2;
  const scenarios = [
    ['ideal 12 V, no current limit', { batteryV: 12, batteryR: 0, statorLimitA: Infinity, efficiency: 1 }],
    ['12.5 V battery, 0.02 ohm, 55 A stator, 90% gearing', { batteryV: 12.5, batteryR: 0.02, statorLimitA: 55, efficiency: 0.9 }],
    ['same plus 60 A of other mechanisms', { batteryV: 12.5, batteryR: 0.02, statorLimitA: 55, efficiency: 0.9, otherLoadA: 60 }],
    ['tired battery 11.8 V, 0.03 ohm, 55 A', { batteryV: 11.8, batteryR: 0.03, statorLimitA: 55, efficiency: 0.9 }],
  ];
  const m = motorModel(motor);
  const freeV = (m.wFree / robot.gearRatio) * r;
  const limitAccel = (robot.motorCount * m.Kt * 55 * robot.gearRatio) / r / robot.massKg;
  console.log(`motor ${motorName}: R=${m.R.toFixed(4)} ohm  Kt=${m.Kt.toFixed(4)} Nm/A  Kv=${m.Kv.toFixed(2)} rad/s/V`);
  console.log(`wheel free speed ${freeV.toFixed(2)} m/s; stall-torque accel ${(robot.motorCount * robot.motorMaxTorqueNm * robot.gearRatio / r / robot.massKg).toFixed(1)} m/s^2; 55 A accel ${limitAccel.toFixed(2)} m/s^2; traction ${(robot.wheelFrictionCoefficient * 9.80665).toFixed(2)} m/s^2`);
  for (const [label, base] of scenarios) {
    const opts = { ...base, motor };
    console.log(`\n${label}`);
    console.log('  v m/s | Bordeaux accel decel | model accel decel | Vbus  statorA');
    for (let v = 0; v <= freeV + 1e-9; v += 0.5) {
      const e = envelopeAt(v, robot, opts);
      const b = bordeauxEnvelopeAt(v, robot);
      console.log(`  ${v.toFixed(1).padStart(5)} | ${b.accel.toFixed(2).padStart(14)} ${b.decel.toFixed(2).padStart(5)} | ${e.accel.toFixed(2).padStart(11)} ${e.decel.toFixed(2).padStart(5)} | ${e.vbus.toFixed(2).padStart(5)} ${e.statorA.toFixed(1).padStart(7)}${e.tractionLimited ? ' traction' : ''}`);
    }
    for (const target of [2, 3, 4]) {
      const d = dragRace(robot, opts, target);
      console.log(`  0->${target} m/s: ${d.v >= target ? `${d.t.toFixed(2)} s over ${d.x.toFixed(2)} m` : `not reached (${d.v.toFixed(2)} m/s after ${d.t.toFixed(1)} s)`}`);
    }
  }
  console.log('\nBordeaux today (same robot):');
  let v = 0; let x = 0; let t = 0;
  for (const target of [2, 3, 4]) {
    while (v < target && t < 5) { const a = bordeauxEnvelopeAt(v, robot).accel; if (a <= 1e-6) break; v += a * 0.001; x += v * 0.001; t += 0.001; }
    console.log(`  0->${target} m/s: ${v >= target ? `${t.toFixed(2)} s over ${x.toFixed(2)} m` : 'not reached'}`);
  }
}
