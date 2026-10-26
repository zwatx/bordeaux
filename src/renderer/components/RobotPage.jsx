import * as React from "react";
import { PointerDrag } from "../hooks/usePointerDrag";
import { committedDraftValue } from "../lib/numericDraft";
import { PM } from "../lib/pathMath";
import { UnitPrefs } from "../lib/unitPreferences";
import { UI } from "./ui";
import { DRIVE_MOTOR_PRESETS } from "../../shared/motorPresets";
import { resolveElectricalDriveInputs } from "../../shared/robotLimits";
import { resolveCgHeightM } from "../../shared/loadTransfer";
import { PowerSettings } from './PowerSettings';
import "../styles/settings.css";

// Bordeaux Robot config page (project-global).
  const { useRef, useState, useEffect } = React;
  const h = React.createElement;
  const { Dropdown, Icon, Seg } = UI;

  const DRIVE_MOTORS = [
    { value: 'custom', label: 'Custom motor', meta: 'Enter its published 12 V figures' },
    ...DRIVE_MOTOR_PRESETS.map((preset) => ({
      value: preset.id, label: preset.label, meta: preset.freeRpm.toLocaleString('en-US') + ' RPM · ' + preset.stallCurrentA + ' A stall',
      rpm: preset.freeRpm, torque: preset.stallTorqueNm, stallCurrent: preset.stallCurrentA, freeCurrent: preset.freeCurrentA,
    })),
  ];
  // Electrical values a project may leave to the shared planning defaults.
  const ELECTRICAL_DEFAULT_KEYS = ['driveCurrentLimitA', 'batteryVoltageV', 'batteryResistanceOhm', 'otherLoadA', 'driveEfficiency', 'controlReserve', 'minimumBusVoltageV'];
  const SECTIONS = [['general', 'General'], ['robot', 'Robot'], ['drive', 'Drivetrain'], ['electrical', 'Electrical'], ['limits', 'Limits'], ['power', 'Loads and breakers'], ['agent', 'Agent profile']];
  const SHAPES = ['Rectangle', 'Round', 'Trapezoid', 'Custom'].map((label) => ({ v: label.toLowerCase(), label }));

  // Explanations are a hover tooltip on an info mark, and screen-reader text beside the name.
  const Hint = ({ text }) => text ? h('span', { className: 'settings-hint', title: text },
    h(Icon, { name: 'info', size: 13 }), h('span', { className: 'sr-only' }, text)) : null;
  // A settings row: the name on the left; a short status and the controls on the right.
  const Row = ({ label, hint, status, className = '', children }) => h('div', { className: 'settings-row ' + className },
    h('div', { className: 'settings-label' }, h('strong', null, label), h(Hint, { text: hint })),
    h('div', { className: 'settings-control' }, status && h('span', { className: 'settings-status' }, status), children));
  const Section = ({ id, title, hint, children }) => h('section', { className: 'settings-section', id: 'settings-' + id },
    h('div', { className: 'settings-head' }, h('h2', { id: 'settings-' + id + '-h', tabIndex: -1 }, title), h(Hint, { text: hint })), children);
  const presetFigures = (preset) => preset && preset.rpm ? { motorFreeRpm: preset.rpm, motorMaxTorqueNm: preset.torque } : {};

  const footprintFor = (shape, w, l, preset) => {
    if (shape === 'rectangle') return undefined;
    const vertexCount = preset && preset.vertices || 12;
    const verticesM = shape === 'round'
      ? Array.from({ length: vertexCount }, (_, index) => {
          const angle = index * Math.PI * 2 / vertexCount;
          return { x: Math.cos(angle) * l / 2, y: Math.sin(angle) * w / 2 };
        })
      : (() => {
          const front = Math.min(w, preset && preset.frontWidthM || w * 0.64) / 2;
          const rear = Math.min(w, preset && preset.rearWidthM || w) / 2;
          return [{ x: -l / 2, y: -rear }, { x: l / 2, y: -front }, { x: l / 2, y: front }, { x: -l / 2, y: rear }];
        })();
    return { kind: 'polygon', verticesM };
  };
  const sameFootprint = (value, expected) => value && expected && value.verticesM.length === expected.verticesM.length
    && value.verticesM.every((point, index) => Math.hypot(point.x - expected.verticesM[index].x, point.y - expected.verticesM[index].y) < 1e-6);
  const footprintShape = (robot) => {
    if (!robot.footprint) return 'rectangle';
    if (robot.footprintPreset) return robot.footprintPreset.kind;
    if (sameFootprint(robot.footprint, footprintFor('round', robot.w, robot.l))) return 'round';
    return sameFootprint(robot.footprint, footprintFor('trapezoid', robot.w, robot.l)) ? 'trapezoid' : 'custom';
  };

  // Numeric settings use explicit input; dragging units or errors must not edit robot configuration.
  function BigNum({ label, value, onChange, unit, imperialUnit = unit === 'm' ? 'in' : undefined, step = 0.01, min, max, precision = 2, disabled = false, placeholder }) {
    const errorId = React.useId();
    const cancelEdit = useRef(false);
    const [edit, setEdit] = useState(null);
    const [error, setError] = useState('');
    const unitSystem = UnitPrefs.current();
    // A unit change can clear the draft while the field stays focused; its rounded
    // text is then presentation, and committing it would change the stored value.
    useEffect(() => {
      setEdit(null);
      setError('');
    }, [unitSystem, disabled]);
    const commitEdit = (raw) => {
      // Leaving an unset optional value empty keeps it unset.
      if (disabled || (typeof value !== 'number' && !raw.trim())) return true;
      const next = committedDraftValue(raw, value, displayValue, (parsed) => UnitPrefs.toCanonical(parsed, unit, imperialUnit), { min, max });
      if (next == null) { setError('Enter a finite number.'); return false; }
      setError('');
      if (!Object.is(next, value)) onChange(next);
      return true;
    };
    const displayValue = typeof value === 'number' ? UnitPrefs.fromCanonical(value, unit, imperialUnit) : value;
    const display = edit != null ? edit : (typeof displayValue === 'number' ? displayValue.toFixed(precision) : '');
    return h('div', { className: 'rp-big' + (disabled ? ' is-disabled' : '') },
      h('input', {
        value: display, disabled, placeholder, inputMode: 'decimal', 'aria-label': label, min, max, step,
        'data-project-draft': true, 'aria-invalid': !!error, 'aria-describedby': error ? errorId : undefined,
        onChange: (e) => { cancelEdit.current = false; setEdit(e.target.value); if (error) setError(''); },
        onFocus: (e) => { cancelEdit.current = false; if (edit == null) setEdit(typeof displayValue === 'number' ? String(displayValue) : ''); requestAnimationFrame(() => { if (document.activeElement === e.target) e.target.select(); }); },
        onBlur: (e) => { const committed = cancelEdit.current || edit == null || commitEdit(e.target.value); cancelEdit.current = false; if (committed) setEdit(null); },
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); if (cancelEdit.current || edit == null || commitEdit(e.currentTarget.value)) { cancelEdit.current = true; e.currentTarget.blur(); } }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit.current = true; setError(''); setEdit(null); requestAnimationFrame(() => { if (document.activeElement === e.target) e.target.select(); }); }
        },
      }),
      unit && h('span', { className: 'u' }, UnitPrefs.label(unit, imperialUnit)),
      error && h('span', { id: errorId, className: 'cmd-param-error', role: 'alert' }, error));
  }

  function RobotPage({ robot, setRobot, unitSystem, setUnitSystem, pushController, mcpEnabled, updateState, onOpenUpdates, agentProposal, onApplyProposal, onRejectProposal }) {
    const isSwerve = robot.drive === 'swerve';
    const [customEditing, setCustomEditing] = useState(false);
    const [current, setCurrent] = useState('general');
    const pageRef = useRef(null), jumped = useRef(false);
    const [selectedVertex, setSelectedVertex] = useState(0);
    const [dragVertices, setDragVertices] = useState(null);
    const previewRef = useRef(null);
    const vertexDrag = PointerDrag.useController();
    const shape = customEditing && robot.footprint ? 'custom' : footprintShape(robot);
    const roundPreset = robot.footprintPreset && robot.footprintPreset.kind === 'round'
      ? robot.footprintPreset : { kind: 'round', vertices: 12 };
    const trapezoidPreset = robot.footprintPreset && robot.footprintPreset.kind === 'trapezoid'
      ? robot.footprintPreset : { kind: 'trapezoid', frontWidthM: robot.w * 0.64, rearWidthM: robot.w };
    const storedFootprint = robot.footprint && robot.footprint.kind === 'polygon' && Array.isArray(robot.footprint.verticesM)
      ? robot.footprint.verticesM
      : [{ x: -robot.l / 2, y: -robot.w / 2 }, { x: robot.l / 2, y: -robot.w / 2 }, { x: robot.l / 2, y: robot.w / 2 }, { x: -robot.l / 2, y: robot.w / 2 }];
    const footprint = dragVertices || storedFootprint;
    const maxDim = Math.max(robot.w, robot.l, 0.4, ...footprint.flatMap((point) => [Math.abs(point.x) * 2, Math.abs(point.y) * 2]));
    const unit = 164 / maxDim;
    const rw = robot.l * unit, rh = robot.w * unit;
    const footprintPoints = footprint.map((point) => `${point.x * unit},${-point.y * unit}`).join(' ');
    const footprintArea = Math.abs(footprint.reduce((area, point, index) => {
      const next = footprint[(index + 1) % footprint.length];
      return area + point.x * next.y - point.y * next.x;
    }, 0)) / 2;
    const footprintCrosses = footprint.map((point, index) => {
      const next = footprint[(index + 1) % footprint.length], after = footprint[(index + 2) % footprint.length];
      return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
    }).filter((value) => Math.abs(value) > 1e-9);
    const winding = Math.sign(footprintCrosses[0] || 0);
    const containsOrigin = winding !== 0 && footprint.every((point, index) => {
      const next = footprint[(index + 1) % footprint.length];
      const cross = (next.x - point.x) * -point.y - (next.y - point.y) * -point.x;
      return Math.abs(cross) <= 1e-9 || Math.sign(cross) === winding;
    });
    const xs = footprint.map((point) => point.x), ys = footprint.map((point) => point.y);
    const withinEnvelope = Math.max(...xs) - Math.min(...xs) <= robot.l + 1e-6
      && Math.max(...ys) - Math.min(...ys) <= robot.w + 1e-6;
    const footprintValid = containsOrigin && withinEnvelope && footprintCrosses.length > 0
      && footprintCrosses.every((value) => Math.sign(value) === winding);

    const planning = robot.planning || {};
    const fallbackRatio = 6.75, fallbackWheelDiameterM = 0.1016;
    const fallbackDriveModel = {
      motorId: 'custom',
      motorFreeRpm: robot.maxSpeed * 60 * fallbackRatio / (Math.PI * fallbackWheelDiameterM),
      motorMaxTorqueNm: 2.6,
      motorCount: 4,
      gearRatio: fallbackRatio,
      wheelDiameterM: fallbackWheelDiameterM,
      massKg: 54,
      moiKgM2: 54 * (robot.l * robot.l + robot.w * robot.w) / 12,
      wheelbaseM: Math.max(0.2, robot.l - 0.18),
      trackwidthM: Math.max(0.2, robot.w - 0.18),
      wheelFrictionCoefficient: 1.2,
    };
    const driveModel = { ...fallbackDriveModel, ...(robot.driveModel || {}) };
    const chassisFreeSpeed = (model) => model.motorFreeRpm / 60 * Math.PI * model.wheelDiameterM / model.gearRatio;
    const hardLimits = PM.robotHardLimits(robot);
    const preset = DRIVE_MOTORS.find((motor) => motor.value === driveModel.motorId && motor.rpm);
    const motorPresetSelected = Boolean(preset);
    const electrical = resolveElectricalDriveInputs(driveModel);
    const cgHeight = resolveCgHeightM(driveModel);
    const setDriveModel = (patch, removeKeys = []) => {
      const next = { ...driveModel, ...patch };
      removeKeys.forEach((key) => { delete next[key]; });
      if (![next.motorFreeRpm, next.gearRatio, next.wheelDiameterM].every((value) => Number.isFinite(value) && value > 0)) return;
      const nextLimits = PM.robotHardLimits({ ...robot, driveModel: next });
      const maxSpeed = nextLimits ? nextLimits.maxSpeed : chassisFreeSpeed(next);
      const nextPlanning = planning.intake && planning.intake.maxCollectSpeedMps > maxSpeed
        ? { ...planning, intake: { ...planning.intake, maxCollectSpeedMps: maxSpeed } }
        : planning;
      setRobot({ driveModel: next, maxSpeed, ...(nextPlanning !== planning ? { planning: nextPlanning } : {}) });
    };
    const driveFields = [
      { label: 'Motor free speed', disabled: motorPresetSelected, value: driveModel.motorFreeRpm, unit: 'RPM', min: 100, max: 30000, precision: 0, step: 25, onChange: (value) => setDriveModel({ motorFreeRpm: value }) },
      { label: 'Motor torque limit', disabled: motorPresetSelected, value: driveModel.motorMaxTorqueNm, unit: 'N·m', min: 0.1, max: 20, precision: 2, step: 0.05, onChange: (value) => setDriveModel({ motorMaxTorqueNm: value }) },
      { label: 'Drive reduction', value: driveModel.gearRatio, unit: ':1', min: 0.1, max: 50, precision: 2, step: 0.05, onChange: (value) => setDriveModel({ gearRatio: value }) },
      { label: 'Wheel diameter', value: driveModel.wheelDiameterM, unit: 'm', imperialUnit: 'in', min: 0.02, max: 0.5, precision: 4, step: 0.001, onChange: (value) => setDriveModel({ wheelDiameterM: value }) },
      { label: 'Drive motors', value: driveModel.motorCount, min: 2, max: 12, precision: 0, step: 1, onChange: (value) => setDriveModel({ motorCount: Math.round(value) }) },
      { label: 'Mass', value: driveModel.massKg, unit: 'kg', min: 5, max: 100, precision: 1, step: 0.5, onChange: (value) => setDriveModel({ massKg: value }) },
      { label: 'Moment of inertia', value: driveModel.moiKgM2, unit: 'kg·m²', min: 0.1, max: 50, precision: 2, step: 0.1, onChange: (value) => setDriveModel({ moiKgM2: value }) },
      { label: 'Wheelbase', value: driveModel.wheelbaseM, unit: 'm', imperialUnit: 'in', min: 0.1, max: robot.l, precision: 3, step: 0.01, onChange: (value) => setDriveModel({ wheelbaseM: value }) },
      { label: 'Trackwidth', value: driveModel.trackwidthM, unit: 'm', imperialUnit: 'in', min: 0.1, max: robot.w, precision: 3, step: 0.01, onChange: (value) => setDriveModel({ trackwidthM: value }) },
      { label: 'Wheel friction', value: driveModel.wheelFrictionCoefficient, unit: 'μ', min: 0.1, max: 3, precision: 2, step: 0.05, onChange: (value) => setDriveModel({ wheelFrictionCoefficient: value }) },
      // Unset uses the shared default; 0 plans with equal wheel loads.
      { label: 'CG height', hint: (cgHeight.defaulted ? 'Using the default. ' : '') + 'Height of the center of gravity above the floor; 0 plans with equal wheel loads.',
        ...(cgHeight.defaulted ? { value: undefined, placeholder: String(+UnitPrefs.fromCanonical(cgHeight.value, 'm', 'in').toFixed(unitSystem === 'imperial' ? 2 : 3)) } : { value: cgHeight.value }),
        unit: 'm', imperialUnit: 'in', min: 0, max: 2, precision: 3, step: 0.01, onChange: (value) => setDriveModel({ cgHeightM: value }) },
    ];
    // Unset values show the effective default as a placeholder; typing stores an explicit value.
    const isDefault = (key) => Boolean(electrical && electrical.defaulted.includes(key));
    const effective = (key, scale = 1) => {
      if (typeof driveModel[key] === 'number') return { value: driveModel[key] * scale };
      return electrical ? { value: undefined, placeholder: String(+(electrical.values[key] * scale).toFixed(3)) } : { value: undefined };
    };
    const electricalFields = [
      { key: 'motorStallCurrentA', label: 'Motor stall current', disabled: motorPresetSelected, ...(motorPresetSelected ? { value: preset.stallCurrent } : effective('motorStallCurrentA')), unit: 'A', min: 1, max: 1000, precision: 0, step: 1, onChange: (value) => setDriveModel({ motorStallCurrentA: value }) },
      { key: 'motorFreeCurrentA', label: 'Motor free current', disabled: motorPresetSelected, ...(motorPresetSelected ? { value: preset.freeCurrent } : effective('motorFreeCurrentA')), unit: 'A', min: 0, max: 50, precision: 1, step: 0.1, onChange: (value) => setDriveModel({ motorFreeCurrentA: value }) },
      { key: 'driveCurrentLimitA', label: 'Drive current limit', hint: 'Stator current limit for each drive motor.', ...effective('driveCurrentLimitA'), unit: 'A', min: 5, max: 1000, precision: 0, step: 1, onChange: (value) => setDriveModel({ driveCurrentLimitA: value }) },
      { key: 'batteryVoltageV', label: 'Battery voltage', hint: 'Resting voltage with no load.', ...effective('batteryVoltageV'), unit: 'V', min: 8, max: 14, precision: 2, step: 0.05, onChange: (value) => setDriveModel({ batteryVoltageV: value }) },
      { key: 'batteryResistanceOhm', label: 'Battery resistance', hint: 'Battery and wiring resistance. Measure it for the condition you plan for.', ...effective('batteryResistanceOhm', 1000), unit: 'mΩ', min: 0, max: 100, precision: 1, step: 0.5, onChange: (value) => setDriveModel({ batteryResistanceOhm: value / 1000 }) },
      { key: 'otherLoadA', label: 'Other mechanisms', hint: 'Current other mechanisms draw while driving.', ...effective('otherLoadA'), unit: 'A', min: 0, max: 300, precision: 0, step: 5, onChange: (value) => setDriveModel({ otherLoadA: value }) },
      { key: 'driveEfficiency', label: 'Drive efficiency', hint: 'Gearbox and wheel losses between motor and floor.', ...effective('driveEfficiency', 100), unit: '%', min: 50, max: 100, precision: 0, step: 1, onChange: (value) => setDriveModel({ driveEfficiency: value / 100 }) },
      { key: 'controlReserve', label: 'Control reserve', hint: 'Torque held back for path-following corrections.', ...effective('controlReserve', 100), unit: '%', min: 0, max: 50, precision: 0, step: 1, onChange: (value) => setDriveModel({ controlReserve: value / 100 }) },
      { label: 'Minimum bus voltage', hint: (driveModel.minimumBusVoltageV === undefined ? 'Using the default. ' : '') + 'Lowest voltage plans may sag to. Keep it above your brownout threshold.', value: driveModel.minimumBusVoltageV, placeholder: '7.25', unit: 'V', min: 1, max: (driveModel.batteryVoltageV ?? 12) - 0.01, precision: 2, step: 0.05, onChange: (value) => setDriveModel({ minimumBusVoltageV: value }) },
    ];
    const fieldHint = (field) => field.disabled ? 'Set by the motor preset.'
      : isDefault(field.key) ? 'Using the default.' + (field.hint ? ' ' + field.hint : '') : field.hint;
    const hasAuthoredElectrical = ELECTRICAL_DEFAULT_KEYS.some((key) => typeof driveModel[key] === 'number');
    // A preset supplies stall and free current; a custom motor keeps the last known figures as editable values.
    const chooseMotor = (motorId) => {
      const next = DRIVE_MOTORS.find((motor) => motor.value === motorId);
      if (next && next.rpm) setDriveModel({ motorId, ...presetFigures(next) }, ['motorStallCurrentA', 'motorFreeCurrentA']);
      else setDriveModel({ motorId, ...(electrical ? { motorStallCurrentA: electrical.values.motorStallCurrentA, motorFreeCurrentA: electrical.values.motorFreeCurrentA } : {}) });
    };
    // Straight-line motoring limit at a fraction of top speed: the flat cap meets the falling torque-speed line.
    const accelAt = (fraction) => hardLimits && Math.max(0, Math.min(hardLimits.maxAccel, hardLimits.motorAccel * (1 - fraction)));
    const intake = planning.intake;
    const shooter = planning.shooter;
    const setPlanning = (patch) => setRobot({ planning: { ...planning, ...patch } });
    const setIntake = (patch) => setPlanning({ intake: { ...intake, ...patch } });
    const setShooter = (patch) => setPlanning({ shooter: { ...shooter, ...patch } });
    const resize = (key, value) => {
      const nextW = key === 'w' ? value : robot.w, nextL = key === 'l' ? value : robot.l;
      const footprint = shape === 'custom' ? {
        kind: 'polygon', verticesM: robot.footprint.verticesM.map((point) => ({
          x: point.x * nextL / robot.l, y: point.y * nextW / robot.w,
        })),
      } : footprintFor(shape, nextW, nextL, shape === 'round' ? roundPreset : {
        ...trapezoidPreset,
        frontWidthM: Math.min(nextW, trapezoidPreset.frontWidthM * nextW / robot.w),
        rearWidthM: Math.min(nextW, trapezoidPreset.rearWidthM * nextW / robot.w),
      });
      const footprintPreset = shape === 'round' ? roundPreset : shape === 'trapezoid'
        ? { ...trapezoidPreset, frontWidthM: Math.min(nextW, trapezoidPreset.frontWidthM * nextW / robot.w), rearWidthM: Math.min(nextW, trapezoidPreset.rearWidthM * nextW / robot.w) }
        : shape === 'custom' ? { kind: 'custom' } : undefined;
      setRobot({ [key]: value, footprint, footprintPreset });
    };
    const setVertices = (verticesM) => setRobot({ footprint: { kind: 'polygon', verticesM }, footprintPreset: { kind: 'custom' } });
    const updateVertex = (index, key, value) => setVertices(footprint.map((point, pointIndex) => (
      pointIndex === index ? { ...point, [key]: value } : point
    )));
    const addVertex = (edgeHint) => {
      if (footprint.length >= 16) return;
      let edge = Number.isInteger(edgeHint) ? edgeHint : 0, longest = Number.isInteger(edgeHint) ? Infinity : -1;
      footprint.forEach((point, index) => {
        const next = footprint[(index + 1) % footprint.length];
        const length = Math.hypot(next.x - point.x, next.y - point.y);
        if (length > longest) { longest = length; edge = index; }
      });
      const next = footprint[(edge + 1) % footprint.length];
      const vertices = footprint.map((point) => ({ ...point }));
      vertices.splice(edge + 1, 0, { x: (footprint[edge].x + next.x) / 2, y: (footprint[edge].y + next.y) / 2 });
      setSelectedVertex(edge + 1);
      setVertices(vertices);
    };
    const eventPoint = (event) => {
      const rect = previewRef.current.getBoundingClientRect();
      return {
        x: Math.max(-robot.l / 2, Math.min(robot.l / 2, (event.clientX - rect.left - rect.width / 2) / unit)),
        y: Math.max(-robot.w / 2, Math.min(robot.w / 2, -(event.clientY - rect.top - rect.height / 2) / unit)),
      };
    };
    const startVertexDrag = (index, event) => {
      event.preventDefault(); event.stopPropagation();
      setSelectedVertex(index); setCustomEditing(true);
      let animationFrame = 0, pendingVertices = null;
      const renderPending = () => { animationFrame = 0; if (pendingVertices) setDragVertices(pendingVertices); };
      const move = (pointer) => {
        const point = eventPoint(pointer);
        pendingVertices = footprint.map((vertex, pointIndex) => pointIndex === index ? point : vertex);
        if (!animationFrame) animationFrame = requestAnimationFrame(renderPending);
      };
      const finish = () => {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        setDragVertices(null);
        if (pendingVertices) setVertices(pendingVertices);
      };
      vertexDrag.start(event, { move, end: finish, cancel: () => { if (animationFrame) cancelAnimationFrame(animationFrame); setDragVertices(null); } });
    };
    const addVertexFromPreview = (event) => {
      if (shape !== 'custom' || footprint.length >= 16) return;
      const point = eventPoint(event);
      let edge = 0, nearest = Infinity;
      footprint.forEach((start, index) => {
        const end = footprint[(index + 1) % footprint.length];
        const dx = end.x - start.x, dy = end.y - start.y;
        const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy || 1)));
        const distance = Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
        if (distance < nearest) { nearest = distance; edge = index; }
      });
      addVertex(edge);
    };
    const setRoundVertices = (vertices) => {
      const preset = { kind: 'round', vertices: Math.max(8, Math.min(16, Math.round(vertices))) };
      setRobot({ footprintPreset: preset, footprint: footprintFor('round', robot.w, robot.l, preset) });
    };
    const setTrapezoidWidth = (key, value) => {
      const preset = { ...trapezoidPreset, [key]: Math.max(0.05, Math.min(robot.w, value)) };
      setRobot({ footprintPreset: preset, footprint: footprintFor('trapezoid', robot.w, robot.l, preset) });
    };
    const numRow = (field) => h(Row, { key: field.key || field.label, label: field.label, hint: fieldHint(field) }, h(BigNum, field));
    const chooseShape = (id) => {
      const preset = id === 'round' ? roundPreset : id === 'trapezoid' ? trapezoidPreset : id === 'custom' ? { kind: 'custom' } : undefined;
      setCustomEditing(id === 'custom');
      setRobot({ footprintPreset: preset, footprint: id === 'custom' ? { kind: 'polygon', verticesM: footprint.map((point) => ({ ...point })) } : footprintFor(id, robot.w, robot.l, preset) });
    };
    const customVerticesEditor = shape === 'custom' && h('div', { className: 'rp-vertices' },
      h('div', { className: 'rp-vertexhead' }, h('span', null, 'Vertices'), h(Hint, { text: 'Drag points in the preview or enter exact coordinates. +X is forward, +Y is left.' })),
      footprint.map((point, index) => h('div', { className: 'rp-vertex' + (selectedVertex === index ? ' selected' : ''), key: index, onClick: () => setSelectedVertex(index) },
        h('span', null, index + 1),
        h('div', { className: 'rp-vertex-coordinate' }, h('span', null, 'X'), h(BigNum, { label: `Vertex ${index + 1} X`, unit: 'm', value: point.x, precision: 3, onChange: (value) => updateVertex(index, 'x', value) })),
        h('div', { className: 'rp-vertex-coordinate' }, h('span', null, 'Y'), h(BigNum, { label: `Vertex ${index + 1} Y`, unit: 'm', value: point.y, precision: 3, onChange: (value) => updateVertex(index, 'y', value) })),
        h('button', { type: 'button', disabled: footprint.length <= 3, 'aria-label': `Remove vertex ${index + 1}`, onClick: () => setVertices(footprint.filter((_, pointIndex) => pointIndex !== index)) }, '×'))),
      h('button', { className: 'qbtn rp-addvertex', type: 'button', disabled: footprint.length >= 16, onClick: () => addVertex() }, 'Add vertex on longest edge'),
      // Errors stay visible.
      !footprintValid && h('div', { className: 'rp-note invalid', role: 'status' }, 'Use a convex footprint around the center, within the robot bounds.'));

    // The rail jumps between sections and follows the reader's scroll position.
    const sections = SECTIONS.filter(([id]) => id !== 'agent' || mcpEnabled);
    const followScroll = () => {
      if (jumped.current) { jumped.current = false; return; }
      const page = pageRef.current, line = page.getBoundingClientRect().top + 120;
      // A short final section cannot reach the top; reaching the end selects it.
      setCurrent(page.scrollTop + page.clientHeight >= page.scrollHeight - 2 ? sections[sections.length - 1][0]
        : sections.reduce((found, [id]) => document.getElementById('settings-' + id).getBoundingClientRect().top <= line ? id : found, 'general'));
    };
    const jump = (id) => {
      const page = pageRef.current, top = page.scrollTop, heading = document.getElementById('settings-' + id + '-h');
      heading.parentNode.scrollIntoView({ block: 'start' });
      heading.focus({ preventScroll: true });
      jumped.current = page.scrollTop !== top;
      setCurrent(id);
    };
    const resetButton = (label, onClick) => h('button', { key: label, className: 'qbtn quiet', type: 'button', onClick }, label);
    const quietRow = (label, onClick) => h('div', { className: 'settings-foot' }, resetButton(label, onClick));

    return h('div', { className: 'robotpage', ref: pageRef, onScroll: followScroll },
      h('div', { className: 'settings-layout' },
        h('div', { className: 'settings-side' },
          h('h1', { className: 'rp-title' }, 'Settings'),
          h('nav', { className: 'settings-nav', 'aria-label': 'Settings sections' },
            sections.map(([id, title]) => h('button', { key: id, type: 'button', 'aria-current': current === id || undefined, onClick: () => jump(id) }, title)))),
        h('div', { className: 'settings-content' },
          h(Section, { id: 'general', title: 'General' },
            h('div', { className: 'settings-card settings-general' },
              h(Row, { label: 'Robot connection', status: pushController.pairing || pushController.busy ? pushController.connectionLabel : 'Not connected' },
                h('button', { className: 'qbtn library-connection', type: 'button', onClick: pushController.openConnection },
                  pushController.busy ? 'Show progress' : pushController.pairing ? 'Edit' : 'Set up')),
              h(Row, { label: 'Display units' },
                h(Seg, { ariaLabel: 'Display units', value: unitSystem, options: [{ v: 'metric', label: 'Metric' }, { v: 'imperial', label: 'Imperial' }], onChange: setUnitSystem })),
              updateState && h(Row, { label: 'Software updates', status: 'Bordeaux ' + updateState.currentVersion + (updateState.phase === 'downloaded' ? ' · Ready to install' : updateState.phase === 'downloading' ? ' · Downloading update' : updateState.phase === 'available' ? ' · Update available' : '') },
                h('button', { className: 'qbtn', type: 'button', onClick: onOpenUpdates }, ['available', 'downloading', 'downloaded', 'installing', 'error'].includes(updateState.phase) ? 'View update' : 'Check for updates')))),

          h(Section, { id: 'robot', title: 'Robot' },
            h('div', { className: 'settings-card rp-robot' },
              h('div', null,
                h(Row, { label: 'Width' }, h(BigNum, { label: 'Robot width', value: robot.w, unit: 'm', min: 0.3, max: 1.3, onChange: (v) => resize('w', v) })),
                h(Row, { label: 'Length' }, h(BigNum, { label: 'Robot length', value: robot.l, unit: 'm', min: 0.3, max: 1.3, onChange: (v) => resize('l', v) })),
                h(Row, { label: 'Height', hint: 'Used for TRENCH clearance checks.', status: typeof robot.heightM === 'number' ? null : 'Needed for TRENCH' },
                  h(BigNum, { label: 'Robot height', value: robot.heightM, unit: 'm', min: 0.1, max: 2.5, onChange: (v) => setRobot({ heightM: v }) })),
                h(Row, { label: 'Bumper shape' }, h(Seg, { className: 'rp-shapes', ariaLabel: 'Robot bumper shape', value: shape, options: SHAPES, onChange: chooseShape })),
                shape === 'round' && h(Row, { label: 'Curve detail', hint: 'Vertices in the collision outline.', status: roundPreset.vertices + ' vertices' },
                  h('input', { type: 'range', min: 8, max: 16, step: 1, value: roundPreset.vertices, 'aria-label': 'Round footprint curve detail', onChange: (event) => setRoundVertices(Number(event.target.value)) })),
                shape === 'trapezoid' && [['frontWidthM', 'Front width'], ['rearWidthM', 'Rear width']].map(([key, label]) => h(Row, { key, label },
                  h(BigNum, { label: 'Trapezoid ' + label.toLowerCase(), value: trapezoidPreset[key], unit: 'm', min: 0.05, max: robot.w, onChange: (value) => setTrapezoidWidth(key, value) })))),
              h('div', { className: 'rp-preview' },
                h('svg', { ref: previewRef, width: 168, height: 168, viewBox: '0 0 200 200',
                  className: shape === 'custom' ? 'editable' : '', onDoubleClick: addVertexFromPreview,
                  'aria-label': shape === 'custom' ? 'Drag a vertex. Double-click an edge to add one.' : 'Robot footprint preview' },
                  h('g', { transform: 'translate(100 100)' },
                    h('polygon', { points: footprintPoints, fill: 'var(--accent-soft)', stroke: 'var(--accent)', strokeWidth: 2, strokeLinejoin: 'round' }),
                    // forward indicator (front = +X)
                    h('line', { x1: 0, y1: 0, x2: rw / 2 + 4, y2: 0, stroke: '#fff', strokeWidth: 2 }),
                    h('path', { d: `M ${rw / 2 + 2} -6 L ${rw / 2 + 14} 0 L ${rw / 2 + 2} 6 Z`, fill: '#fff' }),
                    // width / length ticks
                    h('text', { x: 0, y: -rh / 2 - 10, fill: 'var(--txt-3)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', textAnchor: 'middle' }, UnitPrefs.format(robot.w, 'm', 2, 'in')),
                    h('text', { x: rw / 2 + 26, y: 4, fill: 'var(--txt-3)', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', transform: `rotate(90 ${rw / 2 + 26} 0)`, textAnchor: 'middle' }, UnitPrefs.format(robot.l, 'm', 2, 'in')),
                    shape === 'custom' && footprint.map((point, index) => h('g', { key: index },
                      h('circle', { cx: point.x * unit, cy: -point.y * unit, r: 22, className: 'rp-vertex-hit',
                        role: 'button', tabIndex: 0, 'aria-label': `Footprint vertex ${index + 1}`,
                        onPointerDown: (event) => startVertexDrag(index, event),
                        onDoubleClick: (event) => event.stopPropagation(),
                        onKeyDown: (event) => {
                          const step = event.shiftKey ? 0.05 : 0.01;
                          const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
                          const dy = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
                          if (!dx && !dy) return;
                          event.preventDefault();
                          setSelectedVertex(index);
                          setVertices(footprint.map((vertex, pointIndex) => pointIndex === index ? {
                            x: Math.max(-robot.l / 2, Math.min(robot.l / 2, vertex.x + dx)),
                            y: Math.max(-robot.w / 2, Math.min(robot.w / 2, vertex.y + dy)),
                          } : vertex));
                        },
                      }),
                      h('circle', { cx: point.x * unit, cy: -point.y * unit,
                        r: selectedVertex === index ? 7 : 5, 'aria-hidden': true, pointerEvents: 'none',
                        className: 'rp-vertex-handle' + (selectedVertex === index ? ' selected' : ''),
                      }))))),
                h('small', null, UnitPrefs.fromCanonical(footprintArea, 'm²').toFixed(2) + ' ' + UnitPrefs.label('m²') + ' footprint')),
              customVerticesEditor)),

          h(Section, { id: 'drive', title: 'Drivetrain' },
            h('div', { className: 'settings-card' },
              h(Row, { label: 'Drive type', hint: 'Swerve turns independently of its heading; tank faces along the path.' },
                h(Seg, { ariaLabel: 'Drive type', value: isSwerve ? 'swerve' : 'tank', options: [{ v: 'swerve', label: 'Swerve' }, { v: 'tank', label: 'Tank' }], onChange: (drive) => setRobot({ drive }) })),
              h(Row, { label: 'Drive motor' }, h(Dropdown, { id: 'robot-drive-motor', ariaLabel: 'Drive motor', value: driveModel.motorId, items: DRIVE_MOTORS, onChange: chooseMotor })),
              driveFields.slice(0, 5).map(numRow)),
            h('h3', { className: 'rp-subh' }, 'Chassis'),
            h('div', { className: 'settings-card' },
              driveFields.slice(5).map(numRow),
              !cgHeight.defaulted && quietRow('Use default CG height', () => setDriveModel({}, ['cgHeightM'])))),

          h(Section, { id: 'electrical', title: 'Electrical', hint: electrical
            ? 'Empty fields plan with the grey default shown.'
            : 'Until then, limits assume full stall torque below free speed.' },
            // This state explains the current limits, so it stays visible.
            !electrical && h('p', { className: 'rp-note' }, "Enter the motor's stall and free current to model its current limit and battery sag."),
            h('div', { className: 'settings-card' },
              electricalFields.map(numRow),
              hasAuthoredElectrical && h('div', { className: 'settings-foot' },
                driveModel.minimumBusVoltageV !== undefined && resetButton('Use default minimum voltage', () => setDriveModel({}, ['minimumBusVoltageV'])),
                resetButton('Use default electrical values', () => setDriveModel({}, ELECTRICAL_DEFAULT_KEYS))))),

          h(Section, { id: 'limits', title: 'Limits', hint: 'Derived from the drivetrain and electrical model. Paths and zones can only tighten these limits.' },
            hardLimits
              ? h('div', { className: 'settings-card rp-hard-limits' },
                  [['Top speed', hardLimits.maxSpeed, 'm/s', 2], ['Max acceleration', hardLimits.maxAccel, 'm/s²', 2], ['Acceleration at 3/4 speed', accelAt(0.75), 'm/s²', 2], ['Braking', hardLimits.maxDecel, 'm/s²', 2], ['Corner acceleration', hardLimits.maxCornerAccel, 'm/s²', 2], ['Angular speed', hardLimits.maxAngVel, '°/s', 0]].map(([label, value, unit, precision]) =>
                    h('div', { className: 'rp-drive-result', key: label }, h('span', null, label), h('strong', null, UnitPrefs.fromCanonical(value, unit).toFixed(precision), h('small', null, ' ' + UnitPrefs.label(unit))))))
              : h('button', { className: 'qbtn', type: 'button', onClick: () => setDriveModel({}) }, 'Use physical limits')),

          h(Section, { id: 'power', title: 'Loads and breakers' }, h(PowerSettings, { model: driveModel, setModel: setDriveModel, BigNum, Row })),

          mcpEnabled && h(Section, { id: 'agent', title: 'Agent profile', hint: 'Guides agent plans. Review changes before applying.' },
            agentProposal && h('div', { className: 'settings-card rp-proposal', role: 'region', 'aria-label': 'Agent robot profile proposal' },
              h('b', null, 'Agent robot profile proposal'),
              h('span', null, agentProposal.intent),
              agentProposal.summary && agentProposal.summary.map((line, index) => h('span', { key: index }, line)),
              h('span', { className: 'agent-proposal-status' }, agentProposal.status === 'ready' ? 'Preview only — the robot profile has not changed.' : agentProposal.status === 'stale' ? 'Stale — ask the agent to regenerate.' : agentProposal.status === 'applied' ? 'Applied as one undoable project change.' : 'Rejected.'),
              agentProposal.status === 'ready' && h('div', { className: 'rp-proposal-actions' },
                h('button', { type: 'button', onClick: onRejectProposal }, 'Reject'),
                h('button', { className: 'primary', type: 'button', onClick: onApplyProposal }, 'Apply robot info'))),
            h('div', { className: 'settings-card' },
              intake
                ? [
                    h(Row, { key: 'name', label: 'Primary intake' }, h('input', { className: 'rp-text', value: intake.name || '', 'aria-label': 'Primary intake name', maxLength: 80, onChange: (e) => setIntake({ name: e.target.value }) })),
                    h(Row, { key: 'x', label: 'Local X', hint: '+X is forward.' }, h(BigNum, { label: 'Intake local X', value: intake.centerM && intake.centerM.x, unit: 'm', min: -2, max: 2, onChange: (v) => setIntake({ centerM: { ...(intake.centerM || { x: 0, y: 0 }), x: v } }) })),
                    h(Row, { key: 'y', label: 'Local Y', hint: '+Y is left.' }, h(BigNum, { label: 'Intake local Y', value: intake.centerM && intake.centerM.y, unit: 'm', min: -2, max: 2, onChange: (v) => setIntake({ centerM: { ...(intake.centerM || { x: 0, y: 0 }), y: v } }) })),
                    h(Row, { key: 'dir', label: 'Collection direction', hint: '0° is the robot front.' }, h(BigNum, { label: 'Intake collection direction', value: intake.directionDeg, unit: '°', min: -180, max: 180, precision: 0, step: 1, onChange: (v) => setIntake({ directionDeg: v }) })),
                    h(Row, { key: 'width', label: 'Capture width' }, h(BigNum, { label: 'Intake capture width', value: intake.captureWidthM, unit: 'm', min: 0.05, max: 3, onChange: (v) => setIntake({ captureWidthM: v }) })),
                    h(Row, { key: 'speed', label: 'Collect speed' }, h(BigNum, { label: 'Maximum collection speed', value: intake.maxCollectSpeedMps, unit: 'm/s', min: 0.1, max: robot.maxSpeed, precision: 1, step: 0.1, onChange: (v) => setIntake({ maxCollectSpeedMps: v }) })),
                    h('div', { key: 'remove', className: 'settings-foot' }, h('button', { className: 'qbtn quiet', type: 'button', onClick: () => setPlanning({ intake: undefined }) }, 'Remove intake details')),
                  ]
                : h(Row, { label: 'Intake' }, h('button', { className: 'qbtn', type: 'button', onClick: () => setPlanning({ intake: { name: 'Front intake', centerM: { x: robot.l / 2, y: 0 }, directionDeg: 0, captureWidthM: Math.min(robot.w, 0.7), maxCollectSpeedMps: Math.min(robot.maxSpeed, 2) } }) }, 'Add intake details'))),
            h('div', { className: 'settings-card' },
              shooter
                ? [
                    h(Row, { key: 'dir', label: 'Shooter direction' }, h(BigNum, { label: 'Shooter direction', value: shooter.directionDeg, unit: '°', min: -180, max: 180, precision: 0, step: 1, onChange: (v) => setShooter({ directionDeg: v }) })),
                    h(Row, { key: 'range', label: 'Preferred range' }, h(BigNum, { label: 'Preferred shooting range', value: shooter.preferredRangeM, unit: 'm', imperialUnit: 'm', min: 0.1, max: 20, onChange: (v) => setShooter({ preferredRangeM: v }) })),
                    h('label', { key: 'facing', className: 'settings-row rp-check' }, h('input', { type: 'checkbox', checked: shooter.requiresTargetFacing === true, onChange: (e) => setShooter({ requiresTargetFacing: e.target.checked }) }), 'Shooter direction must face the target'),
                    h('div', { key: 'remove', className: 'settings-foot' },
                      typeof shooter.preferredRangeM === 'number' && h('button', { className: 'qbtn quiet', type: 'button', onClick: () => setPlanning({ shooter: { ...shooter, preferredRangeM: undefined } }) }, 'Clear preferred range'),
                      h('button', { className: 'qbtn quiet', type: 'button', onClick: () => setPlanning({ shooter: undefined }) }, 'Remove shooter details')),
                  ]
                : h(Row, { label: 'Shooter' }, h('button', { className: 'qbtn', type: 'button', onClick: () => setPlanning({ shooter: { directionDeg: 0, requiresTargetFacing: true } }) }, 'Add shooter details'))),
            h('h3', { className: 'rp-subh' }, 'Planning notes'),
            h('textarea', { className: 'rp-notes', value: planning.notes || '', maxLength: 4000, 'aria-label': 'Robot planning notes', placeholder: 'Mechanism timing, preferred lanes, stability limits…', onChange: (e) => setPlanning({ notes: e.target.value }) })))));
  }

export { RobotPage };
