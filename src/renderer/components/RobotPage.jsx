import * as React from "react";
import { PointerDrag } from "../hooks/usePointerDrag";
import { committedDraftValue } from "../lib/numericDraft";
import { PM } from "../lib/pathMath";
import { UnitPrefs } from "../lib/unitPreferences";
import { UI } from "./ui";
import { DRIVE_MOTOR_PRESETS } from "../../shared/motorPresets";
import { resolveElectricalDriveInputs } from "../../shared/robotLimits";
import { resolveCgHeightM } from "../../shared/loadTransfer";
import "../styles/settings.css";

// Bordeaux Robot config page (project-global).
  const { useRef, useState, useEffect } = React;
  const h = React.createElement;
  const { Dropdown, Icon } = UI;

  const DRIVE_MOTORS = [
    { value: 'custom', label: 'Custom motor', meta: 'Enter its published 12 V figures' },
    ...DRIVE_MOTOR_PRESETS.map((preset) => ({
      value: preset.id, label: preset.label, meta: preset.freeRpm.toLocaleString('en-US') + ' RPM · ' + preset.stallCurrentA + ' A stall',
      rpm: preset.freeRpm, torque: preset.stallTorqueNm, stallCurrent: preset.stallCurrentA, freeCurrent: preset.freeCurrentA,
    })),
  ];
  // Electrical values a project may leave to the shared planning defaults.
  const ELECTRICAL_DEFAULT_KEYS = ['driveCurrentLimitA', 'batteryVoltageV', 'batteryResistanceOhm', 'otherLoadA', 'driveEfficiency', 'controlReserve'];
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
    const unit = 220 / maxDim;
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
      { label: 'CG height', note: cgHeight.defaulted ? 'Default · above floor' : 'above floor',
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
      { key: 'driveCurrentLimitA', label: 'Drive current limit', note: 'stator, per motor', ...effective('driveCurrentLimitA'), unit: 'A', min: 5, max: 1000, precision: 0, step: 1, onChange: (value) => setDriveModel({ driveCurrentLimitA: value }) },
      { key: 'batteryVoltageV', label: 'Battery voltage', ...effective('batteryVoltageV'), unit: 'V', min: 8, max: 14, precision: 2, step: 0.05, onChange: (value) => setDriveModel({ batteryVoltageV: value }) },
      { key: 'batteryResistanceOhm', label: 'Battery resistance', note: 'battery and wiring', ...effective('batteryResistanceOhm', 1000), unit: 'mΩ', min: 0, max: 100, precision: 1, step: 0.5, onChange: (value) => setDriveModel({ batteryResistanceOhm: value / 1000 }) },
      { key: 'otherLoadA', label: 'Other mechanisms', note: 'current while driving', ...effective('otherLoadA'), unit: 'A', min: 0, max: 300, precision: 0, step: 5, onChange: (value) => setDriveModel({ otherLoadA: value }) },
      { key: 'driveEfficiency', label: 'Drive efficiency', ...effective('driveEfficiency', 100), unit: '%', min: 50, max: 100, precision: 0, step: 1, onChange: (value) => setDriveModel({ driveEfficiency: value / 100 }) },
      { key: 'controlReserve', label: 'Control reserve', note: 'kept for correction', ...effective('controlReserve', 100), unit: '%', min: 0, max: 50, precision: 0, step: 1, onChange: (value) => setDriveModel({ controlReserve: value / 100 }) },
    ];
    const fieldNote = (field) => (isDefault(field.key) && !field.disabled
      ? (field.note ? 'Default · ' + field.note : 'Default')
      : field.note);
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
    const customVerticesEditor = shape === 'custom' && h('div', { className: 'rp-vertices rp-preview-vertices' },
      h('div', { className: 'rp-vertexhead' }, h('span', null, 'Custom convex vertices'), h('span', null, '+X forward, +Y left')),
      footprint.map((point, index) => h('div', { className: 'rp-vertex' + (selectedVertex === index ? ' selected' : ''), key: index, onClick: () => setSelectedVertex(index) },
        h('span', null, index + 1),
        h('div', { className: 'rp-vertex-coordinate' }, h('span', null, 'X'), h(BigNum, { label: `Vertex ${index + 1} X`, unit: 'm', value: point.x, precision: 3, onChange: (value) => updateVertex(index, 'x', value) })),
        h('div', { className: 'rp-vertex-coordinate' }, h('span', null, 'Y'), h(BigNum, { label: `Vertex ${index + 1} Y`, unit: 'm', value: point.y, precision: 3, onChange: (value) => updateVertex(index, 'y', value) })),
        h('button', { type: 'button', disabled: footprint.length <= 3, 'aria-label': `Remove vertex ${index + 1}`, onClick: () => setVertices(footprint.filter((_, pointIndex) => pointIndex !== index)) }, '\u00d7'))),
      h('button', { className: 'rp-addvertex', type: 'button', disabled: footprint.length >= 16, onClick: () => addVertex() }, 'Add vertex on longest edge'),
      h('div', { className: 'rp-note' + (footprintValid ? '' : ' invalid'), role: footprintValid ? undefined : 'status' }, footprintValid
        ? 'Drag points in the preview or enter exact coordinates.'
        : 'Use a convex footprint around the center, within the robot bounds.'));

    return h('div', { className: 'robotpage' },
      h('div', { className: 'rp-wrap' },
        h('h1', { className: 'rp-title' }, 'Settings'),
        h('section', { className: 'settings-general', 'aria-label': 'General settings' },
          h('div', { className: 'settings-row' },
            h('div', { className: 'settings-label' }, h('strong', null, 'Robot connection'),
              h('span', null, pushController.pairing || pushController.busy ? pushController.connectionLabel : 'Not connected')),
            h('button', { className: 'qbtn library-connection', type: 'button', onClick: pushController.openConnection },
              pushController.busy ? 'Show progress' : pushController.pairing ? 'Edit' : 'Set up')),
          h('div', { className: 'settings-row' },
            h('strong', null, 'Display units'),
            h(UI.Seg, { ariaLabel: 'Display units', value: unitSystem, options: [{ v: 'metric', label: 'Metric' }, { v: 'imperial', label: 'Imperial' }], onChange: setUnitSystem })),
          updateState && h('div', { className: 'settings-row' },
            h('div', { className: 'settings-label' }, h('strong', null, 'Software updates'),
              h('span', null, 'Bordeaux ' + updateState.currentVersion + (updateState.phase === 'downloaded' ? ' · Ready to install' : updateState.phase === 'downloading' ? ' · Downloading update' : updateState.phase === 'available' ? ' · Update available' : ''))),
            h('button', { className: 'qbtn', type: 'button', onClick: onOpenUpdates }, ['available', 'downloading', 'downloaded', 'installing', 'error'].includes(updateState.phase) ? 'View update' : 'Check for updates'))),
        h('h2', { className: 'settings-robot-heading' }, 'Robot'),
        h('div', { className: 'rp-grid' },
          // ---- left column: controls ----
          h('div', { className: 'rp-col rp-controls' },
            h('div', { className: 'rp-sec' },
              h('div', { className: 'rp-sech' }, 'Drivetrain'),
              h('div', { className: 'rp-drive' },
                h('button', { className: 'rp-drivebtn' + (isSwerve ? ' on' : ''), type: 'button', 'aria-pressed': isSwerve, onClick: () => setRobot({ drive: 'swerve' }) },
                  h('span', { className: 'dbi' }, h(Icon, { name: 'swerve', size: 22 })),
                  h('div', { className: 'dbt' }, 'Swerve'),
                  h('div', { className: 'dbd' }, 'Independent heading')),
                h('button', { className: 'rp-drivebtn' + (!isSwerve ? ' on' : ''), type: 'button', 'aria-pressed': !isSwerve, onClick: () => setRobot({ drive: 'tank' }) },
                  h('span', { className: 'dbi' }, h(Icon, { name: 'tank', size: 22 })),
                  h('div', { className: 'dbt' }, 'Tank'),
                  h('div', { className: 'dbd' }, 'Follows path tangent')))),

            h('div', { className: 'rp-sec' },
              h('div', { className: 'rp-sech' }, 'Drive dimensions'),
              h('div', { className: 'rp-two' },
                h('div', { className: 'rp-field' },
                  h('div', { className: 'rp-flabel' }, 'Width'),
                  h(BigNum, { label: 'Robot width', value: robot.w, unit: 'm', min: 0.3, max: 1.3, onChange: (v) => resize('w', v) })),
                h('div', { className: 'rp-field' },
                  h('div', { className: 'rp-flabel' }, 'Length'),
                  h(BigNum, { label: 'Robot length', value: robot.l, unit: 'm', min: 0.3, max: 1.3, onChange: (v) => resize('l', v) }))),
              h('div', { className: 'rp-field' },
                h('div', { className: 'rp-flabel' }, 'Bumper shape'),
                h('div', { className: 'rp-shapes', role: 'group', 'aria-label': 'Robot bumper shape' },
                  [['rectangle', 'Rectangle'], ['round', 'Round'], ['trapezoid', 'Trapezoid'], ['custom', 'Custom']].map(([id, label]) => h('button', {
                    key: id, type: 'button', className: shape === id ? 'on' : '', 'aria-pressed': shape === id,
                    onClick: () => {
                      const preset = id === 'round' ? roundPreset : id === 'trapezoid' ? trapezoidPreset : id === 'custom' ? { kind: 'custom' } : undefined;
                      setCustomEditing(id === 'custom');
                      setRobot({ footprintPreset: preset, footprint: id === 'custom' ? { kind: 'polygon', verticesM: footprint.map((point) => ({ ...point })) } : footprintFor(id, robot.w, robot.l, preset) });
                    },
                  }, label))),
                shape === 'round' && h('div', { className: 'rp-preset-params' },
                  h('div', { className: 'rp-flabel' }, 'Curve detail', h('small', null, roundPreset.vertices + ' vertices')),
                  h('input', { type: 'range', min: 8, max: 16, step: 1, value: roundPreset.vertices, 'aria-label': 'Round footprint curve detail', onChange: (event) => setRoundVertices(Number(event.target.value)) }),
                  h('div', { className: 'rp-note' }, 'Detail sets how closely the collision outline follows the curve.')),
                shape === 'trapezoid' && h('div', { className: 'rp-preset-params rp-two' },
                  h('div', { className: 'rp-field' }, h('div', { className: 'rp-flabel' }, 'Front width'),
                    h(BigNum, { label: 'Trapezoid front width', value: trapezoidPreset.frontWidthM, unit: 'm', min: 0.05, max: robot.w, onChange: (value) => setTrapezoidWidth('frontWidthM', value) })),
                  h('div', { className: 'rp-field' }, h('div', { className: 'rp-flabel' }, 'Rear width'),
                    h(BigNum, { label: 'Trapezoid rear width', value: trapezoidPreset.rearWidthM, unit: 'm', min: 0.05, max: robot.w, onChange: (value) => setTrapezoidWidth('rearWidthM', value) })))),
              h('div', { className: 'rp-field' },
                // The field already shows the selected unit; only an unset height needs a note.
                h('div', { className: 'rp-flabel' }, 'Height', typeof robot.heightM === 'number' ? null : h('small', null, 'required for TRENCH checks')),
                h(BigNum, { label: 'Robot height', value: robot.heightM, unit: 'm', min: 0.1, max: 2.5, onChange: (v) => setRobot({ heightM: v }) })),
              ),

            h('div', { className: 'rp-sec' },
              h('div', { className: 'rp-sech' }, 'Performance'),
              h(Dropdown, { id: 'robot-drive-motor', label: 'Drive motor', value: driveModel.motorId, items: DRIVE_MOTORS,
                onChange: chooseMotor }),
              h('div', { className: 'rp-two rp-drive-model' },
                driveFields.map((field) => h('div', { className: 'rp-field', key: field.label }, h('div', { className: 'rp-flabel' }, field.label, field.note && h('small', null, field.note)), h(BigNum, field)))),
              !cgHeight.defaulted && h('button', { className: 'qbtn quiet rp-use-physical', type: 'button', onClick: () => setDriveModel({}, ['cgHeightM']) }, 'Use default CG height'),
              h('div', { className: 'rp-note' }, 'CG height is the center of gravity above the floor. The default is an estimate; 0 uses equal wheel loads.'),
              h('div', { className: 'rp-subh' }, 'Electrical model'),
              !electrical && h('div', { className: 'rp-note' }, h(Icon, { name: 'info', size: 14 }), "Enter the motor's stall and free current to plan with its current limit and battery sag. Until then, limits assume full stall torque below free speed."),
              h('div', { className: 'rp-two rp-drive-model' },
                electricalFields.map((field) => h('div', { className: 'rp-field', key: field.key }, h('div', { className: 'rp-flabel' }, field.label, fieldNote(field) && h('small', null, fieldNote(field))), h(BigNum, field)))),
              hasAuthoredElectrical && h('button', { className: 'qbtn quiet rp-use-physical', type: 'button', onClick: () => setDriveModel({}, ELECTRICAL_DEFAULT_KEYS) }, 'Use default electrical values'),
              !hardLimits && h('button', { className: 'qbtn rp-use-physical', type: 'button', onClick: () => setDriveModel({}) }, 'Use physical limits'),
              hardLimits && h('div', { className: 'rp-hard-limits' },
                [['Top speed', hardLimits.maxSpeed, 'm/s', 2], ['Max acceleration', hardLimits.maxAccel, 'm/s²', 2], ['Acceleration at 3/4 speed', accelAt(0.75), 'm/s²', 2], ['Braking', hardLimits.maxDecel, 'm/s²', 2], ['Corner acceleration', hardLimits.maxCornerAccel, 'm/s²', 2], ['Angular speed', hardLimits.maxAngVel, '°/s', 0]].map(([label, value, unit, precision]) =>
                  h('div', { className: 'rp-drive-result', key: label }, h('span', null, label), h('strong', null, UnitPrefs.fromCanonical(value, unit).toFixed(precision), h('small', null, ' ' + UnitPrefs.label(unit)))))),
              h('div', { className: 'rp-note' }, h(Icon, { name: 'info', size: 14 }), 'Paths and zones can only tighten these limits.'))),

            mcpEnabled && h('div', { className: 'rp-sec rp-agent' },
              h('div', { className: 'rp-sech' }, 'Agent planning profile'),
              h('div', { className: 'rp-note rp-agent-note' }, h(Icon, { name: 'info', size: 14 }), 'Guides agent plans. Review changes before applying.'),
              agentProposal && h('div', { className: 'rp-proposal', role: 'region', 'aria-label': 'Agent robot profile proposal' },
                h('b', null, 'Agent robot profile proposal'),
                h('span', null, agentProposal.intent),
                agentProposal.summary && agentProposal.summary.map((line, index) => h('span', { key: index }, line)),
                h('span', { className: 'agent-proposal-status' }, agentProposal.status === 'ready' ? 'Preview only — the robot profile has not changed.' : agentProposal.status === 'stale' ? 'Stale — ask the agent to regenerate.' : agentProposal.status === 'applied' ? 'Applied as one undoable project change.' : 'Rejected.'),
                agentProposal.status === 'ready' && h('div', { className: 'rp-proposal-actions' },
                  h('button', { type: 'button', onClick: onRejectProposal }, 'Reject'),
                  h('button', { className: 'primary', type: 'button', onClick: onApplyProposal }, 'Apply robot info'))),
              intake
                ? h('div', { className: 'rp-agent-group' },
                    h('div', { className: 'rp-field' },
                      h('div', { className: 'rp-flabel' }, 'Primary intake'),
                      h('input', { className: 'rp-text', value: intake.name || '', 'aria-label': 'Primary intake name', maxLength: 80, onChange: (e) => setIntake({ name: e.target.value }) })),
                    h('div', { className: 'rp-two' },
                      h('div', { className: 'rp-field' }, h('div', { className: 'rp-flabel' }, 'Local X', h('small', null, '+ forward')), h(BigNum, { label: 'Intake local X', value: intake.centerM && intake.centerM.x, unit: 'm', min: -2, max: 2, onChange: (v) => setIntake({ centerM: { ...(intake.centerM || { x: 0, y: 0 }), x: v } }) })),
                      h('div', { className: 'rp-field' }, h('div', { className: 'rp-flabel' }, 'Local Y', h('small', null, '+ left')), h(BigNum, { label: 'Intake local Y', value: intake.centerM && intake.centerM.y, unit: 'm', min: -2, max: 2, onChange: (v) => setIntake({ centerM: { ...(intake.centerM || { x: 0, y: 0 }), y: v } }) }))),
                    h('div', { className: 'rp-field' }, h('div', { className: 'rp-flabel' }, 'Collection direction', h('small', null, '0° = front')), h(BigNum, { label: 'Intake collection direction', value: intake.directionDeg, unit: '°', min: -180, max: 180, precision: 0, step: 1, onChange: (v) => setIntake({ directionDeg: v }) })),
                    h('div', { className: 'rp-two' },
                      h('div', { className: 'rp-field' }, h('div', { className: 'rp-flabel' }, 'Capture width'), h(BigNum, { label: 'Intake capture width', value: intake.captureWidthM, unit: 'm', min: 0.05, max: 3, onChange: (v) => setIntake({ captureWidthM: v }) })),
                      h('div', { className: 'rp-field' }, h('div', { className: 'rp-flabel' }, 'Collect speed'), h(BigNum, { label: 'Maximum collection speed', value: intake.maxCollectSpeedMps, unit: 'm/s', min: 0.1, max: robot.maxSpeed, precision: 1, step: 0.1, onChange: (v) => setIntake({ maxCollectSpeedMps: v }) }))),
                    h('button', { className: 'delbtn', type: 'button', onClick: () => setPlanning({ intake: undefined }) }, 'Remove intake details'))
                  : h('button', { className: 'rp-add-profile', type: 'button', onClick: () => setPlanning({ intake: { name: 'Front intake', centerM: { x: robot.l / 2, y: 0 }, directionDeg: 0, captureWidthM: Math.min(robot.w, 0.7), maxCollectSpeedMps: Math.min(robot.maxSpeed, 2) } }) }, 'Add intake details'),
              shooter
                ? h('div', { className: 'rp-agent-group' },
                    h('div', { className: 'rp-two' },
                      h('div', { className: 'rp-field' }, h('div', { className: 'rp-flabel' }, 'Shooter direction'), h(BigNum, { label: 'Shooter direction', value: shooter.directionDeg, unit: '°', min: -180, max: 180, precision: 0, step: 1, onChange: (v) => setShooter({ directionDeg: v }) })),
                      h('div', { className: 'rp-field' }, h('div', { className: 'rp-flabel' }, 'Preferred range'), h(BigNum, { label: 'Preferred shooting range', value: shooter.preferredRangeM, unit: 'm', imperialUnit: 'm', min: 0.1, max: 20, onChange: (v) => setShooter({ preferredRangeM: v }) }))),
                    h('label', { className: 'rp-check' }, h('input', { type: 'checkbox', checked: shooter.requiresTargetFacing === true, onChange: (e) => setShooter({ requiresTargetFacing: e.target.checked }) }), 'Shooter direction must face the target'),
                    typeof shooter.preferredRangeM === 'number' && h('button', { className: 'qbtn quiet', type: 'button', onClick: () => setPlanning({ shooter: { ...shooter, preferredRangeM: undefined } }) }, 'Clear preferred range'),
                    h('button', { className: 'delbtn', type: 'button', onClick: () => setPlanning({ shooter: undefined }) }, 'Remove shooter details'))
                : h('button', { className: 'rp-add-profile', type: 'button', onClick: () => setPlanning({ shooter: { directionDeg: 0, requiresTargetFacing: true } }) }, 'Add shooter details'),
              h('div', { className: 'rp-field' },
                h('div', { className: 'rp-flabel' }, 'Planning notes'),
                h('textarea', { className: 'rp-notes', value: planning.notes || '', maxLength: 4000, 'aria-label': 'Robot planning notes', placeholder: 'Mechanism timing, preferred lanes, stability limits…', onChange: (e) => setPlanning({ notes: e.target.value }) }))),

          // ---- right column: live preview ----
          h('div', { className: 'rp-col' },
            h('div', { className: 'rp-preview' },
              h('div', { className: 'rp-stage' },
                h('svg', { ref: previewRef, width: 260, height: 260, viewBox: '0 0 260 260',
                  className: shape === 'custom' ? 'editable' : '', onDoubleClick: addVertexFromPreview,
                  'aria-label': shape === 'custom' ? 'Drag a vertex. Double-click an edge to add one.' : 'Robot footprint preview' },
                  h('g', { transform: 'translate(130 130)' },
                    h('polygon', { points: footprintPoints, fill: 'var(--accent-soft)', stroke: 'var(--accent)', strokeWidth: 2.5, strokeLinejoin: 'round' }),
                    // forward indicator (front = +X)
                    h('line', { x1: 0, y1: 0, x2: rw / 2 + 4, y2: 0, stroke: '#fff', strokeWidth: 2.5 }),
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
                      })))))),
              h('div', { className: 'rp-readout' },
                h('div', { className: 'rr' }, h('div', { className: 'rrv' }, isSwerve ? 'Swerve' : 'Tank'), h('div', { className: 'rru' }, 'drive')),
                h('div', { className: 'rr' }, h('div', { className: 'rrv' }, UnitPrefs.fromCanonical(footprintArea, 'm²').toFixed(2)), h('div', { className: 'rru' }, UnitPrefs.label('m²') + ' footprint')),
                h('div', { className: 'rr' }, h('div', { className: 'rrv' }, typeof robot.heightM === 'number' ? UnitPrefs.fromCanonical(robot.heightM, 'm', 'in').toFixed(2) : '—'), h('div', { className: 'rru' }, UnitPrefs.label('m', 'in') + ' high')),
                h('div', { className: 'rr' }, h('div', { className: 'rrv' }, UnitPrefs.fromCanonical(robot.maxSpeed, 'm/s').toFixed(1)), h('div', { className: 'rru' }, UnitPrefs.label('m/s') + ' top')))),
            customVerticesEditor))));
  }

export { RobotPage };
