import type { RobotValueSchema, ValidationIssue, ValidationResult } from "./types";
import { normalizeLabviewProjectPath } from "./project/labviewLink";
import { robotSchemaValueError } from "./robotCommands";
import { FIELD_H, FIELD_W } from "./math/fieldBounds";
import { ACTIVE_FIELD_REFERENCE } from "./field/rebuilt2026";
import { acceptedTrajectoryShapeError } from "./planners/acceptedTrajectoryIdentity";

type RecordValue = Record<string, unknown>;

const MAX_PROJECT_PATHS = 1_024;
const MAX_PATH_ITEMS = 4_096;
const MAX_PROJECT_ROUTINES = 1_024;
const MAX_ROUTINE_NODES = 100_000;
const MAX_ROUTINE_DEPTH = 64;

function issue(path: string, message: string, severity: "error" | "warning" = "error"): ValidationIssue {
  return { path, message, severity };
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateFinite(issues: ValidationIssue[], value: unknown, path: string, label: string, options: { positive?: boolean; nonnegative?: boolean } = {}) {
  if (!finite(value)) {
    issues.push(issue(path, `${label} must be a finite number`));
  } else if (options.positive && value <= 0) {
    issues.push(issue(path, `${label} must be greater than zero`));
  } else if (options.nonnegative && value < 0) {
    issues.push(issue(path, `${label} cannot be negative`));
  }
}

function validateOptionalFinite(issues: ValidationIssue[], value: unknown, path: string, label: string, options: { positive?: boolean; nonnegative?: boolean } = {}) {
  if (value !== undefined) validateFinite(issues, value, path, label, options);
}

function validatePoint(issues: ValidationIssue[], value: unknown, path: string, label: string) {
  if (!isRecord(value)) {
    issues.push(issue(path, `${label} is required`));
    return;
  }
  validateFinite(issues, value.x, `${path}.x`, `${label} X`);
  validateFinite(issues, value.y, `${path}.y`, `${label} Y`);
}

function validateRobotFootprint(issues: ValidationIssue[], robot: RecordValue): void {
  if (robot.footprintPreset !== undefined) {
    const presetPath = "$.robot.footprintPreset";
    if (!isRecord(robot.footprintPreset) || !["round", "trapezoid", "custom"].includes(String(robot.footprintPreset.kind))) {
      issues.push(issue(presetPath, "Robot footprint preset must be round, trapezoid, or custom"));
    } else if (robot.footprintPreset.kind === "round"
      && (!Number.isInteger(robot.footprintPreset.vertices) || Number(robot.footprintPreset.vertices) < 8 || Number(robot.footprintPreset.vertices) > 16)) {
      issues.push(issue(`${presetPath}.vertices`, "Round footprint detail must contain between 8 and 16 vertices"));
    } else if (robot.footprintPreset.kind === "trapezoid") {
      validateFinite(issues, robot.footprintPreset.frontWidthM, `${presetPath}.frontWidthM`, "Trapezoid front width", { positive: true });
      validateFinite(issues, robot.footprintPreset.rearWidthM, `${presetPath}.rearWidthM`, "Trapezoid rear width", { positive: true });
      if (finite(robot.w) && ((finite(robot.footprintPreset.frontWidthM) && robot.footprintPreset.frontWidthM > robot.w)
        || (finite(robot.footprintPreset.rearWidthM) && robot.footprintPreset.rearWidthM > robot.w))) {
        issues.push(issue(presetPath, "Trapezoid widths cannot exceed the robot width"));
      }
    }
  }
  if (isRecord(robot.footprintPreset) && robot.footprintPreset.kind === "custom" && robot.footprint === undefined) {
    issues.push(issue("$.robot.footprint", "A custom footprint preset requires polygon vertices"));
  }
  if (robot.footprint === undefined) return;
  const path = "$.robot.footprint";
  if (!isRecord(robot.footprint)) {
    issues.push(issue(path, "Robot footprint must be an object"));
    return;
  }
  if (robot.footprint.kind !== "polygon") issues.push(issue(`${path}.kind`, "Robot footprint kind must be polygon"));
  const vertices = robot.footprint.verticesM;
  if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > 16) {
    issues.push(issue(`${path}.verticesM`, "Robot footprint must contain between 3 and 16 vertices"));
    return;
  }
  const points = vertices.flatMap((vertex, index) => {
    if (!isRecord(vertex) || !finite(vertex.x) || !finite(vertex.y)) {
      issues.push(issue(`${path}.verticesM[${index}]`, "Robot footprint vertices must contain finite X and Y coordinates"));
      return [];
    }
    return [{ x: vertex.x, y: vertex.y }];
  });
  if (points.length !== vertices.length) return;

  const crosses = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const after = points[(index + 2) % points.length];
    return (next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x);
  }).filter((value) => Math.abs(value) > 1e-9);
  if (crosses.length === 0 || crosses.some((value) => Math.sign(value) !== Math.sign(crosses[0]))) {
    issues.push(issue(`${path}.verticesM`, "Robot footprint must be a non-self-intersecting convex polygon"));
    return;
  }
  const winding = Math.sign(crosses[0]);
  const containsOrigin = points.every((point, index) => {
    const next = points[(index + 1) % points.length];
    const originCross = (next.x - point.x) * -point.y - (next.y - point.y) * -point.x;
    return Math.abs(originCross) <= 1e-9 || Math.sign(originCross) === winding;
  });
  if (!containsOrigin) issues.push(issue(`${path}.verticesM`, "Robot footprint must contain the robot reference point at (0, 0)"));

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  if (finite(robot.l) && maxX - minX > robot.l + 1e-6) issues.push(issue(`${path}.verticesM`, "Robot footprint forward extent cannot exceed robot length"));
  if (finite(robot.w) && maxY - minY > robot.w + 1e-6) issues.push(issue(`${path}.verticesM`, "Robot footprint lateral extent cannot exceed robot width"));
}

function validateRobotPlanning(issues: ValidationIssue[], robot: RecordValue): void {
  if (robot.planning === undefined) return;
  const path = "$.robot.planning";
  if (!isRecord(robot.planning)) {
    issues.push(issue(path, "Robot planning profile must be an object"));
    return;
  }
  const planning = robot.planning;
  if (planning.notes !== undefined && (typeof planning.notes !== "string" || planning.notes.length > 4_000)) {
    issues.push(issue(`${path}.notes`, "Robot planning notes must be text no longer than 4,000 characters"));
  }
  if (planning.intake !== undefined) {
    const intakePath = `${path}.intake`;
    if (!isRecord(planning.intake)) issues.push(issue(intakePath, "Intake profile must be an object"));
    else {
      if (typeof planning.intake.name !== "string" || !planning.intake.name.trim() || planning.intake.name.length > 80) issues.push(issue(`${intakePath}.name`, "Intake name must contain 1 to 80 characters"));
      validatePoint(issues, planning.intake.centerM, `${intakePath}.centerM`, "Intake center");
      validateFinite(issues, planning.intake.directionDeg, `${intakePath}.directionDeg`, "Intake direction");
      validateFinite(issues, planning.intake.captureWidthM, `${intakePath}.captureWidthM`, "Intake capture width", { positive: true });
      validateFinite(issues, planning.intake.maxCollectSpeedMps, `${intakePath}.maxCollectSpeedMps`, "Maximum collection speed", { positive: true });
      if (finite(planning.intake.directionDeg) && Math.abs(planning.intake.directionDeg) > 180) issues.push(issue(`${intakePath}.directionDeg`, "Intake direction must be between -180 and 180 degrees"));
      if (finite(planning.intake.captureWidthM) && planning.intake.captureWidthM > 3) issues.push(issue(`${intakePath}.captureWidthM`, "Intake capture width cannot exceed 3 m"));
      if (finite(planning.intake.maxCollectSpeedMps) && finite(robot.maxSpeed) && planning.intake.maxCollectSpeedMps > robot.maxSpeed + 1e-9) {
        issues.push(issue(`${intakePath}.maxCollectSpeedMps`, "Maximum collection speed cannot exceed robot max speed"));
      }
    }
  }
  if (planning.shooter !== undefined) {
    const shooterPath = `${path}.shooter`;
    if (!isRecord(planning.shooter)) issues.push(issue(shooterPath, "Shooter profile must be an object"));
    else {
      validateFinite(issues, planning.shooter.directionDeg, `${shooterPath}.directionDeg`, "Shooter direction");
      if (finite(planning.shooter.directionDeg) && Math.abs(planning.shooter.directionDeg) > 180) issues.push(issue(`${shooterPath}.directionDeg`, "Shooter direction must be between -180 and 180 degrees"));
      if (typeof planning.shooter.requiresTargetFacing !== "boolean") issues.push(issue(`${shooterPath}.requiresTargetFacing`, "Shooter target-facing setting must be true or false"));
      validateOptionalFinite(issues, planning.shooter.preferredRangeM, `${shooterPath}.preferredRangeM`, "Preferred shooting range", { positive: true });
    }
  }
}

function validateCommandArgumentValue(issues: ValidationIssue[], value: unknown, path: string, depth = 0): void {
  if (depth > 24) {
    issues.push(issue(path, "Command argument nesting cannot exceed 24 levels"));
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push(issue(path, "Command argument numbers must be finite"));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) {
      issues.push(issue(path, "Command argument arrays cannot exceed 1024 items"));
      return;
    }
    value.forEach((item, index) => validateCommandArgumentValue(issues, item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 256) {
      issues.push(issue(path, "Command argument objects cannot exceed 256 fields"));
      return;
    }
    entries.forEach(([key, item]) => validateCommandArgumentValue(issues, item, `${path}.${key}`, depth + 1));
    return;
  }
  issues.push(issue(path, "Command arguments must contain only JSON-compatible values"));
}

function validateRoutineCondition(issues: ValidationIssue[], value: unknown, path: string, allowOutput: boolean) {
  if (!isRecord(value)) { issues.push(issue(path, "Routine condition must be an object")); return; }
  if (value.source === "condition") {
    if (typeof value.conditionId !== "string") issues.push(issue(`${path}.conditionId`, "Condition ID must be a string"));
    return;
  }
  if (!allowOutput || value.source !== "output") { issues.push(issue(`${path}.source`, "Condition source is invalid")); return; }
  if (typeof value.nodeId !== "string" || typeof value.output !== "string") issues.push(issue(path, "Output stop selectors must be strings"));
  const schema = value.schema;
  if (schema !== undefined) {
    const valid = isRecord(schema) && typeof schema.kind === "string" && ["boolean", "enum", "integer", "number", "integerString", "decimalString"].includes(schema.kind)
      && typeof schema.valueType === "string" && Boolean(schema.valueType.trim())
      && (schema.kind !== "enum" || (Array.isArray(schema.enumValues) && schema.enumValues.length > 0 && schema.enumValues.length <= 255
        && schema.enumValues.every(item => typeof item === "string" && item.length > 0) && new Set(schema.enumValues).size === schema.enumValues.length));
    if (!valid) issues.push(issue(`${path}.schema`, "Output stop schema is invalid"));
    else if (value.value !== undefined) {
      const error = robotSchemaValueError(value.value, schema as unknown as RobotValueSchema, "Stop value");
      if (error) issues.push(issue(`${path}.value`, error));
    }
  }
  if (value.value !== undefined && !["boolean", "string", "number"].includes(typeof value.value)) issues.push(issue(`${path}.value`, "Stop value must be a scalar"));
  if (typeof value.value === "number" && !Number.isFinite(value.value)) issues.push(issue(`${path}.value`, "Stop value must be finite"));
  const allowed = isRecord(schema) && ["boolean", "enum"].includes(schema.kind as string) ? ["eq"] : ["eq", "neq", "lt", "lte", "gt", "gte"];
  if (typeof value.operator !== "string" || !allowed.includes(value.operator)) issues.push(issue(`${path}.operator`, "Output comparison is invalid"));
}

function validateRoutineEnds(issues: ValidationIssue[], node: RecordValue, base: string) {
  if (node.ends === undefined) return;
  const command = node.type === "function" && node.cat === "command";
  const wait = node.type === "builtin" && node.builtinId === "bordeaux.wait";
  if (!command && !wait) { issues.push(issue(`${base}.ends`, "Only commands and waits can have ending conditions")); return; }
  if (!isRecord(node.ends)) { issues.push(issue(`${base}.ends`, "Ending conditions must be an object")); return; }
  const ends = node.ends;
  if (ends.endWhen !== undefined) validateRoutineCondition(issues, ends.endWhen, `${base}.ends.endWhen`, false);
  if (ends.timeoutS !== undefined && (!command || !finite(ends.timeoutS) || ends.timeoutS < 0.02 || ends.timeoutS > 15)) issues.push(issue(`${base}.ends.timeoutS`, "Command timeout must be from 0.02 to 15 seconds"));
  if (ends.onTimeout !== undefined && (!command || ends.timeoutS === undefined || (typeof ends.onTimeout !== "string" || !["continue", "endRoutine"].includes(ends.onTimeout)))) issues.push(issue(`${base}.ends.onTimeout`, "Timeout policy requires a command timeout and must be Continue or End routine"));
}

function validateRoutineNodes(
  issues: ValidationIssue[],
  value: unknown,
  path: string,
  pathIds: Set<string>,
  nodeIds: Set<string>,
  state = { count: 0 },
  depth = 0,
) {
  if (!Array.isArray(value)) {
    issues.push(issue(path, "Routine nodes must be an array"));
    return;
  }
  if (depth > MAX_ROUTINE_DEPTH) {
    issues.push(issue(path, `Routine nesting cannot exceed ${MAX_ROUTINE_DEPTH} levels`));
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (state.count >= MAX_ROUTINE_NODES) {
      issues.push(issue(path, `Routine cannot exceed ${MAX_ROUTINE_NODES} nodes`));
      return;
    }
    state.count += 1;
    const node = value[index];
    const base = `${path}[${index}]`;
    if (!isRecord(node)) {
      issues.push(issue(base, "Routine node must be an object"));
      continue;
    }
    if (typeof node.id !== "string" || !node.id.trim()) issues.push(issue(`${base}.id`, "Routine node ID is required"));
    else if (nodeIds.has(node.id)) issues.push(issue(`${base}.id`, "Routine node IDs must be unique"));
    else nodeIds.add(node.id);

    if (node.outputBranch !== undefined && (node.type !== "function" || node.cat !== "command")) {
      issues.push(issue(`${base}.outputBranch`, "Only a command can branch on an output"));
    }
    validateRoutineEnds(issues, node, base);
    if (node.type === "repeat") {
      if (node.times === undefined) {
        if (!isRecord(node.until) || node.until.source !== 'output') issues.push(issue(`${base}.until`, "Dynamic repeats require a command output stop rule"));
      } else if (!Number.isInteger(node.times) || (node.times as number) < 1 || (node.times as number) > 50) issues.push(issue(`${base}.times`, "Repeat count must be an integer from 1 to 50"));
      if (node.until !== undefined) validateRoutineCondition(issues, node.until, `${base}.until`, true);
      validateRoutineNodes(issues, node.nodes, `${base}.nodes`, pathIds, nodeIds, state, depth + 1);
      continue;
    }
    if (node.type === "end") {
      if (typeof node.scope !== "string" || !["routine", "repeat"].includes(node.scope)) issues.push(issue(`${base}.scope`, "End scope must be routine or repeat"));
      continue;
    }


    if (node.type === "path") {
      if (typeof node.ref !== "string" || !pathIds.has(node.ref)) issues.push(issue(`${base}.ref`, "Routine path reference must match a path ID"));
      continue;
    }
    if (node.type === "decision") {
      if (typeof node.cond !== "string") issues.push(issue(`${base}.cond`, "Decision condition is required"));
      if (typeof node.thenLabel !== "string" || typeof node.elseLabel !== "string") issues.push(issue(base, "Decision branch labels are required"));
      validateRoutineNodes(issues, node.then, `${base}.then`, pathIds, nodeIds, state, depth + 1);
      validateRoutineNodes(issues, node.else, `${base}.else`, pathIds, nodeIds, state, depth + 1);
      continue;
    }
    if (node.type === "builtin") {
      if (node.builtinId !== "bordeaux.wait") {
        issues.push(issue(`${base}.builtinId`, "Routine built-in is not supported"));
      }
      if (!isRecord(node.arguments)) {
        issues.push(issue(`${base}.arguments`, "Wait arguments are required"));
      } else {
        const names = Object.keys(node.arguments);
        if (names.length !== 1 || names[0] !== "durationS") {
          issues.push(issue(`${base}.arguments`, "Wait accepts only the durationS argument"));
        }
        const durationS = node.arguments.durationS;
        if (!finite(durationS) || durationS < 0.02 || durationS > 15) {
          issues.push(issue(`${base}.arguments.durationS`, "Wait duration must be a finite number from 0.02 to 15 seconds"));
        }
      }
      continue;
    }
    if (node.type !== "function") {
      issues.push(issue(`${base}.type`, "Routine node type is invalid"));
      return;
    }
    if (!["command", "terminate", "sequence", "generate", "velocity"].includes(String(node.cat))) issues.push(issue(`${base}.cat`, "Routine function category is invalid"));
    validateOptionalFinite(issues, node.scale, `${base}.scale`, "Velocity scale", { nonnegative: true });
    if (node.outputBranch !== undefined) {
      const branch = node.outputBranch;
      const branchPath = `${base}.outputBranch`;
      if (!isRecord(branch)) { issues.push(issue(branchPath, "Command output branch must be an object")); continue; }
      if (typeof branch.output !== "string" || !branch.output.trim() || branch.output.length > 256) issues.push(issue(`${branchPath}.output`, "A command output name of at most 256 characters is required"));
      const schema = branch.schema;
      const schemaValid = isRecord(schema) && typeof schema.kind === "string" && ["boolean", "enum", "integer", "number", "integerString", "decimalString"].includes(schema.kind)
        && typeof schema.valueType === "string" && Boolean(schema.valueType.trim())
        && (schema.kind !== "enum" || (Array.isArray(schema.enumValues) && schema.enumValues.length > 0 && schema.enumValues.length <= 255
          && schema.enumValues.every((item) => typeof item === "string" && item.length > 0)
          && new Set(schema.enumValues).size === schema.enumValues.length));
      if (!schemaValid) issues.push(issue(`${branchPath}.schema`, "Branch output must have a Boolean, named outcome, or numeric schema"));
      if (!Array.isArray(branch.routes) || branch.routes.length < 2 || branch.routes.length > 256) {
        issues.push(issue(`${branchPath}.routes`, "Output branches require between 2 and 256 routes"));
        continue;
      }
      const routeIds = new Set<string>();
      const routes = branch.routes;
      const values = new Set<unknown>();
      let otherwiseCount = 0;
      routes.forEach((route, routeIndex) => {
        const routePath = `${branchPath}.routes[${routeIndex}]`;
        if (!isRecord(route)) { issues.push(issue(routePath, "Output route must be an object")); return; }
        if (typeof route.id !== "string" || !route.id.trim() || routeIds.has(route.id)) issues.push(issue(`${routePath}.id`, "Output route IDs must be present and unique"));
        else routeIds.add(route.id);
        if (typeof route.label !== "string" || !route.label.trim()) issues.push(issue(`${routePath}.label`, "Output route label is required"));
        if (route.operator === "otherwise") {
          otherwiseCount += 1;
          if (routeIndex !== routes.length - 1 || route.value !== undefined) issues.push(issue(routePath, "Otherwise must be the final route and have no comparison value"));
        } else {
          const allowed = isRecord(schema) && ["boolean", "enum"].includes(schema.kind as string) ? ["eq"] : ["eq", "neq", "lt", "lte", "gt", "gte"];
          if (typeof route.operator !== "string" || !allowed.includes(route.operator)) issues.push(issue(`${routePath}.operator`, "Output route comparison is invalid for this output type"));
          if (schemaValid) {
            const error = robotSchemaValueError(route.value, schema as unknown as RobotValueSchema, "Comparison value");
            if (error) issues.push(issue(`${routePath}.value`, error));
          }
          if (isRecord(schema) && ["boolean", "enum"].includes(schema.kind as string) && values.has(route.value)) issues.push(issue(`${routePath}.value`, "Output routes must not repeat the same outcome"));
          values.add(route.value);
        }
        validateRoutineNodes(issues, route.nodes, `${routePath}.nodes`, pathIds, nodeIds, state, depth + 1);
      });
      if (isRecord(schema) && schema.kind === "boolean") {
        if (otherwiseCount !== 0 || branch.routes.length !== 2 || !values.has(true) || !values.has(false)) issues.push(issue(`${branchPath}.routes`, "Boolean output branches require one True route and one False route"));
      } else if (otherwiseCount !== 1) issues.push(issue(`${branchPath}.routes`, "Named outcome and numeric branches require one final Otherwise route"));
    }
  }
}

function validateProjectInner(project: unknown, allowIncompletePaths = false): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!isRecord(project)) return { ok: false, issues: [issue("$", "Project must be a JSON object")] };

  if (project.schemaVersion !== "1.0" && project.schemaVersion !== "1.1" && project.schemaVersion !== "1.2") issues.push(issue("$.schemaVersion", "Schema version must be 1.0, 1.1 or 1.2"));
  if (!isRecord(project.field)) issues.push(issue("$.field", "Field reference is required"));
  else {
    if (project.field.id !== ACTIVE_FIELD_REFERENCE.id) issues.push(issue("$.field.id", "Field ID is not supported"));
    if (project.field.revision !== ACTIVE_FIELD_REFERENCE.revision) issues.push(issue("$.field.revision", "Field revision is not supported"));
    if (project.field.coordinateSchemaId !== ACTIVE_FIELD_REFERENCE.coordinateSchemaId) issues.push(issue("$.field.coordinateSchemaId", "Coordinate schema is not supported"));
  }
  if (project.fieldMigration !== undefined) {
    if (!isRecord(project.fieldMigration) || !["legacy-unpinned", "bordeaux-field/1.0"].includes(String(project.fieldMigration.source)) || !isRecord(project.fieldMigration.assigned)) {
      issues.push(issue("$.fieldMigration", "Field migration record is invalid"));
    } else if (!isRecord(project.field)
      || project.fieldMigration.assigned.id !== project.field.id
      || project.fieldMigration.assigned.revision !== project.field.revision
      || project.fieldMigration.assigned.coordinateSchemaId !== project.field.coordinateSchemaId) {
      issues.push(issue("$.fieldMigration.assigned", "Field migration assignment must match the project field reference"));
    }
  }
  if (typeof project.name !== "string" || !project.name.trim()) issues.push(issue("$.name", "Project name is required"));
  if (!["profiledSpline", "optimizedTrajectory"].includes(String(project.plannerId))) {
    issues.push(issue("$.plannerId", "Planner must be profiledSpline or optimizedTrajectory"));
  }

  if (!isRecord(project.robot)) {
    issues.push(issue("$.robot", "Robot config is required"));
  } else {
    if (project.robot.drive !== "swerve" && project.robot.drive !== "tank") issues.push(issue("$.robot.drive", "Drive must be swerve or tank"));
    validateFinite(issues, project.robot.w, "$.robot.w", "Robot width", { positive: true });
    validateFinite(issues, project.robot.l, "$.robot.l", "Robot length", { positive: true });
    validateOptionalFinite(issues, project.robot.heightM, "$.robot.heightM", "Robot height", { positive: true });
    validateFinite(issues, project.robot.maxSpeed, "$.robot.maxSpeed", "Robot max speed", { positive: true });
    if (project.robot.driveModel !== undefined) {
      const modelPath = "$.robot.driveModel";
      if (!isRecord(project.robot.driveModel)) issues.push(issue(modelPath, "Robot drive model must be an object"));
      else {
        if (typeof project.robot.driveModel.motorId !== "string" || !project.robot.driveModel.motorId.trim()) issues.push(issue(`${modelPath}.motorId`, "Drive motor ID is required"));
        validateFinite(issues, project.robot.driveModel.motorFreeRpm, `${modelPath}.motorFreeRpm`, "Motor free speed", { positive: true });
        validateFinite(issues, project.robot.driveModel.gearRatio, `${modelPath}.gearRatio`, "Drive gear ratio", { positive: true });
        validateFinite(issues, project.robot.driveModel.wheelDiameterM, `${modelPath}.wheelDiameterM`, "Drive wheel diameter", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.motorMaxTorqueNm, `${modelPath}.motorMaxTorqueNm`, "Motor torque limit", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.motorCount, `${modelPath}.motorCount`, "Drive motor count", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.massKg, `${modelPath}.massKg`, "Robot mass", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.moiKgM2, `${modelPath}.moiKgM2`, "Robot moment of inertia", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.wheelbaseM, `${modelPath}.wheelbaseM`, "Wheelbase", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.trackwidthM, `${modelPath}.trackwidthM`, "Trackwidth", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.wheelFrictionCoefficient, `${modelPath}.wheelFrictionCoefficient`, "Wheel friction coefficient", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.motorStallCurrentA, `${modelPath}.motorStallCurrentA`, "Motor stall current", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.motorFreeCurrentA, `${modelPath}.motorFreeCurrentA`, "Motor free current", { nonnegative: true });
        validateOptionalFinite(issues, project.robot.driveModel.driveCurrentLimitA, `${modelPath}.driveCurrentLimitA`, "Drive current limit", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.batteryVoltageV, `${modelPath}.batteryVoltageV`, "Battery voltage", { positive: true });
        validateOptionalFinite(issues, project.robot.driveModel.batteryResistanceOhm, `${modelPath}.batteryResistanceOhm`, "Battery resistance", { nonnegative: true });
        validateOptionalFinite(issues, project.robot.driveModel.otherLoadA, `${modelPath}.otherLoadA`, "Other mechanism current", { nonnegative: true });
        validateOptionalFinite(issues, project.robot.driveModel.driveEfficiency, `${modelPath}.driveEfficiency`, "Drive efficiency", { positive: true });
        if (typeof project.robot.driveModel.driveEfficiency === "number" && project.robot.driveModel.driveEfficiency > 1) {
          issues.push(issue(`${modelPath}.driveEfficiency`, "Drive efficiency must be at most 1"));
        }
        validateOptionalFinite(issues, project.robot.driveModel.controlReserve, `${modelPath}.controlReserve`, "Control reserve", { nonnegative: true });
        if (typeof project.robot.driveModel.controlReserve === "number" && project.robot.driveModel.controlReserve > 0.5) {
          issues.push(issue(`${modelPath}.controlReserve`, "Control reserve must be at most 0.5"));
        }
        if (project.robot.driveModel.motorCount !== undefined && !Number.isInteger(project.robot.driveModel.motorCount)) {
          issues.push(issue(`${modelPath}.motorCount`, "Drive motor count must be an integer"));
        }
      }
    }
    validateRobotFootprint(issues, project.robot);
    validateRobotPlanning(issues, project.robot);
  }

  const pathIds = new Set<string>();
  const markerIds = new Set<string>();
  const folderIds = new Set<string>();
  if (project.pathFolders !== undefined) {
    if (!Array.isArray(project.pathFolders)) issues.push(issue("$.pathFolders", "Path folders must be an array"));
    else project.pathFolders.forEach((folder, index) => {
      const base = `$.pathFolders[${index}]`;
      if (!isRecord(folder)) { issues.push(issue(base, "Path folder must be an object")); return; }
      if (typeof folder.id !== "string" || !folder.id.trim()) issues.push(issue(`${base}.id`, "Folder ID is required"));
      else if (folderIds.has(folder.id)) issues.push(issue(`${base}.id`, "Folder IDs must be unique"));
      else folderIds.add(folder.id);
      if (typeof folder.name !== "string" || !folder.name.trim()) issues.push(issue(`${base}.name`, "Folder name is required"));
    });
  }
  if (!Array.isArray(project.paths)) {
    issues.push(issue("$.paths", "Project paths must be an array"));
  } else if (project.paths.length === 0) {
    issues.push(issue("$.paths", "Project must contain at least one path"));
  } else if (project.paths.length > MAX_PROJECT_PATHS) {
    issues.push(issue("$.paths", `Project cannot contain more than ${MAX_PROJECT_PATHS} paths`));
  } else {
    project.paths.forEach((path, pi) => {
      const base = `$.paths[${pi}]`;
      if (!isRecord(path)) {
        issues.push(issue(base, "Path must be an object"));
        return;
      }
      if (typeof path.id !== "string" || !path.id.trim()) issues.push(issue(`${base}.id`, "Path ID is required"));
      else if (pathIds.has(path.id)) issues.push(issue(`${base}.id`, "Path IDs must be unique"));
      else pathIds.add(path.id);
      if (typeof path.name !== "string" || !path.name.trim()) issues.push(issue(`${base}.name`, "Path name is required"));
      if (path.folderId !== undefined && (typeof path.folderId !== "string" || !folderIds.has(path.folderId))) issues.push(issue(`${base}.folderId`, "Path folder does not exist"));
      if (path.driveBackward !== undefined && typeof path.driveBackward !== "boolean") issues.push(issue(`${base}.driveBackward`, "Drive backward must be true or false"));
      if (path.exportable !== undefined && typeof path.exportable !== "boolean") issues.push(issue(`${base}.exportable`, "Exportable must be true or false"));
      if (path.routeRequiredPointIndices !== undefined) issues.push(issue(`${base}.routeRequiredPointIndices`, "Solver point mapping is not authored source"));
      if (path.optimization !== undefined) {
        const options = path.optimization;
        if (!isRecord(options)) issues.push(issue(`${base}.optimization`, "Optimization must be an object"));
        else {
          if ((options.corridorM !== undefined || (isRecord(options.accepted) && options.accepted.version === 1) || options.legacyAccepted !== undefined)
            && (!finite(options.corridorM) || options.corridorM < 0.03 || options.corridorM > 1.5)) {
            issues.push(issue(`${base}.optimization`, "Optimization corridor must be between 0.03 and 1.5 meters"));
          }
          if (options.accepted !== undefined) {
            const error = acceptedTrajectoryShapeError(options.accepted);
            if (error) issues.push(issue(`${base}.optimization.accepted`, error));
          }
          if (options.legacyAccepted !== undefined) {
            const error = !isRecord(options.legacyAccepted) || options.legacyAccepted.version !== 1
              ? "Archived selection must be a legacy version 1 trajectory" : acceptedTrajectoryShapeError(options.legacyAccepted);
            if (error) issues.push(issue(`${base}.optimization.legacyAccepted`, error));
          }
        }
      }
      if (path.headingMode !== undefined && !["manual", "tangent", "targets"].includes(String(path.headingMode))) issues.push(issue(`${base}.headingMode`, "Heading mode is invalid"));
      if (path.followMode !== undefined && !["time", "position"].includes(String(path.followMode))) issues.push(issue(`${base}.followMode`, "Follow mode must be time or position"));
      validateFinite(issues, path.startVel, `${base}.startVel`, "Start velocity", { nonnegative: true });
      validateFinite(issues, path.goalVel, `${base}.goalVel`, "Goal velocity", { nonnegative: true });

      if (!Array.isArray(path.waypoints)) {
        issues.push(issue(`${base}.waypoints`, "Waypoints must be an array"));
      } else if (path.waypoints.length > MAX_PATH_ITEMS) {
        issues.push(issue(`${base}.waypoints`, `Path cannot contain more than ${MAX_PATH_ITEMS} waypoints`));
      } else {
        const waypointCount = path.waypoints.length;
        if (waypointCount < 2 && !allowIncompletePaths) issues.push(issue(`${base}.waypoints`, "Path must contain at least two waypoints"));
        path.waypoints.forEach((waypoint, wi) => {
          const wpBase = `${base}.waypoints[${wi}]`;
          if (!isRecord(waypoint)) {
            issues.push(issue(wpBase, "Waypoint must be an object"));
            return;
          }
          validateFinite(issues, waypoint.x, `${wpBase}.x`, "Waypoint X");
          validateFinite(issues, waypoint.y, `${wpBase}.y`, "Waypoint Y");
          if (waypoint.positionLink !== undefined && (typeof waypoint.positionLink !== "string" || !waypoint.positionLink.trim())) issues.push(issue(`${wpBase}.positionLink`, "Shared position ID must be a nonempty string"));
          if (finite(waypoint.x) && finite(waypoint.y) && (waypoint.x < 0 || waypoint.x > FIELD_W || waypoint.y < 0 || waypoint.y > FIELD_H)) {
            issues.push(issue(wpBase, "Waypoint must stay inside the FRC field bounds"));
          }
          if (waypoint.positionName !== undefined && (typeof waypoint.positionName !== "string" || !waypoint.positionName.trim() || waypoint.positionName.length > 80)) {
            issues.push(issue(`${wpBase}.positionName`, "Linkable point name must contain 1–80 characters"));
          }
          validateFinite(issues, waypoint.theta, `${wpBase}.theta`, "Waypoint heading");
          (["thetaOn", "linked", "stop"] as const).forEach((key) => {
            if (typeof waypoint[key] !== "boolean") issues.push(issue(`${wpBase}.${key}`, `${key} must be true or false`));
          });
          if (waypoint.corner !== undefined && typeof waypoint.corner !== "boolean") issues.push(issue(`${wpBase}.corner`, "Corner must be true or false"));
          validateOptionalFinite(issues, waypoint.wait, `${wpBase}.wait`, "Waypoint wait", { nonnegative: true });
          if (finite(waypoint.wait) && waypoint.wait > 0 && waypoint.stop !== true) {
            issues.push(issue(`${wpBase}.wait`, "Wait requires a stopped waypoint"));
          }
          validatePoint(issues, waypoint.prevC, `${wpBase}.prevC`, "Previous control handle");
          validatePoint(issues, waypoint.nextC, `${wpBase}.nextC`, "Next control handle");
          if (wi > 0 && wi < waypointCount - 1 && waypoint.stop !== true) {
            if (waypoint.linked !== true) issues.push(issue(`${wpBase}.linked`, "Moving waypoints must keep tangent handles linked"));
            if (finite(waypoint.x) && finite(waypoint.y) && isRecord(waypoint.prevC) && isRecord(waypoint.nextC)
              && finite(waypoint.prevC.x) && finite(waypoint.prevC.y) && finite(waypoint.nextC.x) && finite(waypoint.nextC.y)) {
              const inX = waypoint.x - waypoint.prevC.x;
              const inY = waypoint.y - waypoint.prevC.y;
              const outX = waypoint.nextC.x - waypoint.x;
              const outY = waypoint.nextC.y - waypoint.y;
              const scale = Math.max(1e-9, Math.hypot(inX, inY) * Math.hypot(outX, outY));
              if (Math.abs(inX * outY - inY * outX) / scale > 1e-3 || (inX * outX + inY * outY) <= 0) {
                issues.push(issue(`${wpBase}.linked`, "Moving waypoint tangent handles must be collinear"));
              }
            }
          }
          if (waypoint.segType !== undefined && !["bezier", "line", "arc", "clothoid"].includes(String(waypoint.segType))) issues.push(issue(`${wpBase}.segType`, "Segment type is invalid"));
          if (waypoint.segmentHeadingMode !== undefined && !["manual", "tangent", "targets", "lookAt"].includes(String(waypoint.segmentHeadingMode))) issues.push(issue(`${wpBase}.segmentHeadingMode`, "Segment heading mode is invalid"));
          if (waypoint.segmentFollowMode !== undefined && !["time", "position"].includes(String(waypoint.segmentFollowMode))) issues.push(issue(`${wpBase}.segmentFollowMode`, "Segment follow mode must be time or position"));
          if (waypoint.segmentLookAt !== undefined) {
            validatePoint(issues, waypoint.segmentLookAt, `${wpBase}.segmentLookAt`, "Tracked field point");
            if (isRecord(waypoint.segmentLookAt) && finite(waypoint.segmentLookAt.x) && finite(waypoint.segmentLookAt.y)
              && (waypoint.segmentLookAt.x < 0 || waypoint.segmentLookAt.x > FIELD_W || waypoint.segmentLookAt.y < 0 || waypoint.segmentLookAt.y > FIELD_H)) {
              issues.push(issue(`${wpBase}.segmentLookAt`, "Tracked field point must stay inside the FRC field bounds"));
            }
          }
          if (waypoint.segmentHeadingMode === "lookAt" && !isRecord(waypoint.segmentLookAt)) issues.push(issue(`${wpBase}.segmentLookAt`, "Track point heading requires a field point"));
          if (waypoint.turnInPlace !== undefined) {
            if (!isRecord(waypoint.turnInPlace)) issues.push(issue(`${wpBase}.turnInPlace`, "Turn in place must be an object"));
            else {
              validateFinite(issues, waypoint.turnInPlace.headingDeg, `${wpBase}.turnInPlace.headingDeg`, "Turn heading");
              if (waypoint.turnInPlace.direction !== undefined && !["shortest", "clockwise", "counterclockwise"].includes(String(waypoint.turnInPlace.direction))) issues.push(issue(`${wpBase}.turnInPlace.direction`, "Turn direction is invalid"));
              if (waypoint.stop !== true) issues.push(issue(`${wpBase}.turnInPlace`, "Turn in place requires a stopped waypoint"));
            }
          }
          if (waypoint.jiggle !== undefined) {
            if (!isRecord(waypoint.jiggle)) issues.push(issue(`${wpBase}.jiggle`, "Jiggle must be an object"));
            else {
              validateFinite(issues, waypoint.jiggle.distanceM, `${wpBase}.jiggle.distanceM`, "Jiggle distance", { positive: true });
              validateFinite(issues, waypoint.jiggle.strokes, `${wpBase}.jiggle.strokes`, "Jiggle stroke count", { positive: true });
              validateFinite(issues, waypoint.jiggle.startDeg, `${wpBase}.jiggle.startDeg`, "Jiggle first direction");
              validateFinite(issues, waypoint.jiggle.stepDeg, `${wpBase}.jiggle.stepDeg`, "Jiggle direction step");
              validateFinite(issues, waypoint.jiggle.strokeTimeS, `${wpBase}.jiggle.strokeTimeS`, "Jiggle stroke time", { positive: true });
              if (finite(waypoint.jiggle.strokes) && (!Number.isInteger(waypoint.jiggle.strokes) || waypoint.jiggle.strokes < 2 || waypoint.jiggle.strokes > 12)) {
                issues.push(issue(`${wpBase}.jiggle.strokes`, "Jiggle stroke count must be an integer from 2 to 12"));
              }
              if (finite(waypoint.jiggle.distanceM) && (waypoint.jiggle.distanceM < 0.03 || waypoint.jiggle.distanceM > 1.5)) {
                issues.push(issue(`${wpBase}.jiggle.distanceM`, "Jiggle distance must be from 0.03 to 1.5 meters"));
              }
              if (finite(waypoint.jiggle.strokeTimeS) && (waypoint.jiggle.strokeTimeS < 0.08 || waypoint.jiggle.strokeTimeS > 5)) {
                issues.push(issue(`${wpBase}.jiggle.strokeTimeS`, "Jiggle stroke time must be from 0.08 to 5 seconds"));
              }
              if (wi !== waypointCount - 1) issues.push(issue(`${wpBase}.jiggle`, "Jiggle is only supported on the final waypoint"));
              if (isRecord(project.robot) && project.robot.drive === "tank") issues.push(issue(`${wpBase}.jiggle`, "Arbitrary-direction jiggle requires a swerve drivetrain"));
              if (finite(path.goalVel) && path.goalVel > 1e-9) issues.push(issue(`${base}.goalVel`, "Goal velocity must be zero when the endpoint has a jiggle"));
              if (finite(waypoint.jiggle.strokes) && finite(waypoint.jiggle.startDeg) && finite(waypoint.jiggle.stepDeg)) {
                const directions = new Set<number>();
                for (let stroke = 0; stroke < Math.max(0, Math.min(12, Math.floor(waypoint.jiggle.strokes))); stroke += 1) {
                  const direction = Math.round((((waypoint.jiggle.startDeg + waypoint.jiggle.stepDeg * stroke) % 360) + 360) % 360 * 1000) / 1000;
                  if (directions.has(direction)) {
                    issues.push(issue(`${wpBase}.jiggle.stepDeg`, "Jiggle directions must not repeat"));
                    break;
                  }
                  directions.add(direction);
                }
              }
            }
          }
        });
      }

      const collections: Array<[string, unknown]> = [["targets", path.targets], ["markers", path.markers], ["ranges", path.ranges]];
      collections.forEach(([name, value]) => {
        if (!Array.isArray(value)) issues.push(issue(`${base}.${name}`, `${name[0].toUpperCase()}${name.slice(1)} must be an array`));
        else if (value.length > MAX_PATH_ITEMS) issues.push(issue(`${base}.${name}`, `Path cannot contain more than ${MAX_PATH_ITEMS} ${name}`));
      });
      if (Array.isArray(path.targets) && path.targets.length <= MAX_PATH_ITEMS) path.targets.forEach((target, i) => {
        const targetBase = `${base}.targets[${i}]`;
        if (!isRecord(target)) return issues.push(issue(targetBase, "Rotation target must be an object"));
        validateFinite(issues, target.f, `${targetBase}.f`, "Target fraction");
        validateFinite(issues, target.deg, `${targetBase}.deg`, "Target angle");
        if (target.anchor !== undefined && target.anchor !== "param" && target.anchor !== "dist") issues.push(issue(`${targetBase}.anchor`, "Target position lock is invalid"));
        validateOptionalFinite(issues, target.d, `${targetBase}.d`, "Target distance", { nonnegative: true });
        if (finite(target.f) && (target.f < 0 || target.f > 1)) issues.push(issue(`${targetBase}.f`, "Target fraction must be between 0 and 1"));
      });
      if (Array.isArray(path.markers) && path.markers.length <= MAX_PATH_ITEMS) path.markers.forEach((marker, i) => {
        const markerBase = `${base}.markers[${i}]`;
        if (!isRecord(marker)) return issues.push(issue(markerBase, "Marker must be an object"));
        if (marker.id !== undefined) {
          if (typeof marker.id !== "string" || !marker.id.trim()) issues.push(issue(`${markerBase}.id`, "Marker ID must be a nonempty string"));
          else if (markerIds.has(marker.id)) issues.push(issue(`${markerBase}.id`, "Marker IDs must be unique"));
          else markerIds.add(marker.id);
        }
        validateFinite(issues, marker.f, `${markerBase}.f`, "Marker fraction");
        if (marker.anchor !== undefined && marker.anchor !== "param" && marker.anchor !== "dist") issues.push(issue(`${markerBase}.anchor`, "Marker position lock is invalid"));
        validateOptionalFinite(issues, marker.d, `${markerBase}.d`, "Marker distance", { nonnegative: true });
        if (finite(marker.f) && (marker.f < 0 || marker.f > 1)) issues.push(issue(`${markerBase}.f`, "Marker fraction must be between 0 and 1"));
        if (typeof marker.name !== "string" || !marker.name.trim()) issues.push(issue(`${markerBase}.name`, "Marker name is required"));
        if (marker.cmd !== undefined && typeof marker.cmd !== "string") issues.push(issue(`${markerBase}.cmd`, "Legacy marker command must be a string"));
        if (marker.group !== undefined && marker.group !== "sequential" && marker.group !== "parallel" && marker.group !== "deadline") issues.push(issue(`${markerBase}.group`, "Marker group is invalid"));
        if (marker.schedule !== undefined) {
          if (!isRecord(marker.schedule)) issues.push(issue(`${markerBase}.schedule`, "Event schedule must be an object"));
          else {
            if (marker.schedule.trigger !== undefined && marker.schedule.trigger !== "time" && marker.schedule.trigger !== "position") issues.push(issue(`${markerBase}.schedule.trigger`, "Event trigger must be time or position"));
            validateOptionalFinite(issues, marker.schedule.repeatEveryS, `${markerBase}.schedule.repeatEveryS`, "Repeat period", { positive: true });
            if (finite(marker.schedule.repeatEveryS) && marker.schedule.repeatEveryS < 0.001) issues.push(issue(`${markerBase}.schedule.repeatEveryS`, "Repeat period cannot be less than 0.001 seconds"));
            validateOptionalFinite(issues, marker.schedule.endTimeS, `${markerBase}.schedule.endTimeS`, "Event end time", { nonnegative: true });
            if (typeof marker.schedule.conditionId !== "undefined" && (typeof marker.schedule.conditionId !== "string" || !/^[A-Za-z0-9_.:#()$,-]{1,256}$/.test(marker.schedule.conditionId))) issues.push(issue(`${markerBase}.schedule.conditionId`, "Condition ID is invalid"));
          }
        }
        if (marker.invocation !== undefined) {
          if (!isRecord(marker.invocation)) {
            issues.push(issue(`${markerBase}.invocation`, "Command invocation must be an object"));
          } else {
            if (typeof marker.invocation.commandId !== "string" || !marker.invocation.commandId.trim()) {
              issues.push(issue(`${markerBase}.invocation.commandId`, "Command ID is required"));
            }
            if (!isRecord(marker.invocation.arguments)) {
              issues.push(issue(`${markerBase}.invocation.arguments`, "Command arguments must be an object"));
            } else {
              validateCommandArgumentValue(issues, marker.invocation.arguments, `${markerBase}.invocation.arguments`);
            }
            if (marker.invocation.cancelOnPathEnd !== undefined && typeof marker.invocation.cancelOnPathEnd !== "boolean") {
              issues.push(issue(`${markerBase}.invocation.cancelOnPathEnd`, "Cancel on path end must be true or false"));
            }
          }
        }
        if (marker.actionIntent !== undefined) {
          if (!isRecord(marker.actionIntent)) {
            issues.push(issue(`${markerBase}.actionIntent`, "Action intent must be an object"));
          } else {
            if (typeof marker.actionIntent.semanticTag !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(marker.actionIntent.semanticTag)) {
              issues.push(issue(`${markerBase}.actionIntent.semanticTag`, "Action intent semantic tag is invalid"));
            }
            if (typeof marker.actionIntent.description !== "string" || !marker.actionIntent.description.trim()) {
              issues.push(issue(`${markerBase}.actionIntent.description`, "Action intent description is required"));
            }
          }
        }
      });
      if (Array.isArray(path.ranges) && path.ranges.length <= MAX_PATH_ITEMS) path.ranges.forEach((range, i) => {
        const rangeBase = `${base}.ranges[${i}]`;
        if (!isRecord(range)) return issues.push(issue(rangeBase, "Constraint range must be an object"));
        if (!["param", "dist", "wp"].includes(String(range.anchor))) issues.push(issue(`${rangeBase}.anchor`, "Constraint range anchor is invalid"));
        validateOptionalFinite(issues, range.t0, `${rangeBase}.t0`, "Constraint range start segment position", { nonnegative: true });
        validateOptionalFinite(issues, range.t1, `${rangeBase}.t1`, "Constraint range end segment position", { nonnegative: true });
        if (finite(range.t0) && range.t0 > 1) issues.push(issue(`${rangeBase}.t0`, "Constraint range start segment position cannot exceed one"));
        if (finite(range.t1) && range.t1 > 1) issues.push(issue(`${rangeBase}.t1`, "Constraint range end segment position cannot exceed one"));
        if (range.t0 !== undefined || range.t1 !== undefined) {
          const segmentCount = Array.isArray(path.waypoints) ? Math.max(0, path.waypoints.length - 1) : 0;
          (["w0", "w1"] as const).forEach((key) => {
            const segmentIndex = range[key];
            if (!Number.isInteger(segmentIndex)) issues.push(issue(`${rangeBase}.${key}`, "Local constraint range segment must be an integer"));
            else if ((segmentIndex as number) < 0 || (segmentIndex as number) >= segmentCount) issues.push(issue(`${rangeBase}.${key}`, "Local constraint range segment is outside the path"));
          });
        }
        ["f0", "f1"].forEach((key) => validateFinite(issues, range[key], `${rangeBase}.${key}`, `Range ${key}`));
        ["d0", "d1", "w0", "w1", "maxVel", "maxAccel", "maxDecel", "maxAngVel", "maxAngAccel"].forEach((key) => validateOptionalFinite(issues, range[key], `${rangeBase}.${key}`, `Range ${key}`, key.startsWith("max") ? { positive: true } : { nonnegative: true }));
      });

      if (!isRecord(path.constraints)) {
        issues.push(issue(`${base}.constraints`, "Path constraints are required"));
      } else {
        const constraints = path.constraints;
        ["maxVel", "maxAccel", "maxDecel", "maxAngVel", "maxAngAccel"].forEach((key) => validateFinite(issues, constraints[key], `${base}.constraints.${key}`, key, { positive: true }));
        validateOptionalFinite(issues, constraints.maxCentripetalAccel, `${base}.constraints.maxCentripetalAccel`, "maxCentripetalAccel", { positive: true });
        validateOptionalFinite(issues, constraints.maxAngDecel, `${base}.constraints.maxAngDecel`, "maxAngDecel", { positive: true });
        ["maxJerk", "maxAngJerk"].forEach((key) => validateOptionalFinite(issues, constraints[key], `${base}.constraints.${key}`, key, { nonnegative: true }));
      }
    });
  }

  if (project.editor !== undefined) {
    if (!isRecord(project.editor)) issues.push(issue("$.editor", "Editor state must be an object"));
    else {
      if (project.editor.activePathId !== undefined && (typeof project.editor.activePathId !== "string" || !pathIds.has(project.editor.activePathId))) {
        issues.push(issue("$.editor.activePathId", "Active path must reference a project path"));
      }
      if (project.editor.robotProjectBookmarkId !== undefined && (typeof project.editor.robotProjectBookmarkId !== "string" || !/^[a-f0-9]{20}$/.test(project.editor.robotProjectBookmarkId))) {
        issues.push(issue("$.editor.robotProjectBookmarkId", "Robot project bookmark is invalid"));
      }
      if (project.editor.labviewProjectPath !== undefined && project.editor.labviewProjectPath !== null) {
        try { normalizeLabviewProjectPath(project.editor.labviewProjectPath); }
        catch { issues.push(issue("$.editor.labviewProjectPath", "LabVIEW link must be a local relative .lvproj path")); }
      }
      if (project.editor.unitSystem !== undefined && project.editor.unitSystem !== "metric" && project.editor.unitSystem !== "imperial") {
        issues.push(issue("$.editor.unitSystem", "Display units must be metric or imperial"));
      }
    }
  }

  if (!Array.isArray(project.pathLinks)) {
    issues.push(issue("$.pathLinks", "Path links must be an array"));
  } else {
    const linkIds = new Set<string>(), sources = new Set<string>(), targets = new Set<string>();
    project.pathLinks.forEach((link, index) => {
      const base = `$.pathLinks[${index}]`;
      if (!isRecord(link)) { issues.push(issue(base, "Path link must be an object")); return; }
      if (typeof link.id !== "string" || !link.id.trim()) issues.push(issue(`${base}.id`, "Path link ID is required"));
      else if (linkIds.has(link.id)) issues.push(issue(`${base}.id`, "Path link IDs must be unique"));
      else linkIds.add(link.id);
      if (typeof link.fromPathId !== "string" || !pathIds.has(link.fromPathId)) issues.push(issue(`${base}.fromPathId`, "Linked source path does not exist"));
      else if (sources.has(link.fromPathId)) issues.push(issue(`${base}.fromPathId`, "A path end can have only one link"));
      else sources.add(link.fromPathId);
      if (typeof link.toPathId !== "string" || !pathIds.has(link.toPathId)) issues.push(issue(`${base}.toPathId`, "Linked target path does not exist"));
      else if (targets.has(link.toPathId)) issues.push(issue(`${base}.toPathId`, "A path start can have only one link"));
      else targets.add(link.toPathId);
      if (link.fromPathId === link.toPathId) issues.push(issue(base, "A path cannot link to itself"));
    });
  }

  const validateRoutine = (routine: unknown, base: string) => {
    if (!isRecord(routine)) { issues.push(issue(base, "Routine must be an object")); return; }
    if (typeof routine.name !== "string" || !routine.name.trim()) issues.push(issue(`${base}.name`, "Routine name is required"));
    validateRoutineNodes(issues, routine.nodes, `${base}.nodes`, pathIds, new Set());
  };
  if (!Array.isArray(project.routines) || project.routines.length === 0) issues.push(issue("$.routines", "Project routines must be a non-empty array"));
  else if (project.routines.length > MAX_PROJECT_ROUTINES) issues.push(issue("$.routines", `Project cannot contain more than ${MAX_PROJECT_ROUTINES} routines`));
  else {
    const routineIds = new Set<string>();
    project.routines.forEach((routine, index) => {
      const base = `$.routines[${index}]`; validateRoutine(routine, base);
      if (!isRecord(routine) || typeof routine.id !== "string" || !routine.id.trim()) issues.push(issue(`${base}.id`, "Routine ID is required"));
      else if (routineIds.has(routine.id)) issues.push(issue(`${base}.id`, "Routine IDs must be unique"));
      else routineIds.add(routine.id);
    });
    if (typeof project.activeRoutineId !== "string" || !routineIds.has(project.activeRoutineId)) issues.push(issue("$.activeRoutineId", "Active routine must reference a project routine"));
  }

  if (project.strategy !== undefined) {
    if (!isRecord(project.strategy)) issues.push(issue("$.strategy", "Project strategy must be an object"));
    else {
      const locationIds = new Set<string>();
      const locationTerms = new Set<string>();
      if (project.strategy.locations !== undefined && !Array.isArray(project.strategy.locations)) issues.push(issue("$.strategy.locations", "Strategy locations must be an array"));
      else if (Array.isArray(project.strategy.locations)) project.strategy.locations.forEach((location, index) => {
        const base = `$.strategy.locations[${index}]`;
        if (!isRecord(location)) { issues.push(issue(base, "Strategy location must be an object")); return; }
        if (typeof location.id !== "string" || !location.id.trim()) issues.push(issue(`${base}.id`, "Strategy location ID is required"));
        else if (locationIds.has(location.id)) issues.push(issue(`${base}.id`, "Strategy location IDs must be unique"));
        else locationIds.add(location.id);
        if (typeof location.name !== "string" || !location.name.trim()) issues.push(issue(`${base}.name`, "Strategy location name is required"));
        const aliases = location.aliases === undefined ? [] : location.aliases;
        if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string" || !alias.trim())) issues.push(issue(`${base}.aliases`, "Strategy aliases must be non-empty strings"));
        [location.name, ...(Array.isArray(aliases) ? aliases : [])].filter((term): term is string => typeof term === "string").forEach((term) => {
          const normalized = term.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
          if (locationTerms.has(normalized)) issues.push(issue(base, `Strategy location term “${term}” is ambiguous`));
          else locationTerms.add(normalized);
        });
        validateOptionalFinite(issues, location.headingDeg, `${base}.headingDeg`, "Strategy heading");
        if (location.kind === "pose") {
          validateFinite(issues, location.x, `${base}.x`, "Strategy pose X");
          validateFinite(issues, location.y, `${base}.y`, "Strategy pose Y");
          if (finite(location.x) && finite(location.y) && (location.x < 0 || location.x > FIELD_W || location.y < 0 || location.y > FIELD_H)) issues.push(issue(base, "Strategy pose must stay inside the FRC field bounds"));
        } else if (location.kind === "region") {
          if (!isRecord(location.bounds)) issues.push(issue(`${base}.bounds`, "Strategy region bounds are required"));
          else {
            const bounds = location.bounds;
            ["xMin", "xMax", "yMin", "yMax"].forEach((key) => validateFinite(issues, bounds[key], `${base}.bounds.${key}`, `Strategy region ${key}`));
            if (finite(bounds.xMin) && finite(bounds.xMax) && finite(bounds.yMin) && finite(bounds.yMax)
              && (bounds.xMin < 0 || bounds.xMax > FIELD_W || bounds.yMin < 0 || bounds.yMax > FIELD_H || bounds.xMin >= bounds.xMax || bounds.yMin >= bounds.yMax)) {
              issues.push(issue(`${base}.bounds`, "Strategy region bounds must be ordered inside the FRC field"));
            }
          }
        } else issues.push(issue(`${base}.kind`, "Strategy location kind must be pose or region"));
      });
      const bindingTags = new Set<string>();
      if (project.strategy.actionBindings !== undefined && !Array.isArray(project.strategy.actionBindings)) issues.push(issue("$.strategy.actionBindings", "Strategy action bindings must be an array"));
      else if (Array.isArray(project.strategy.actionBindings)) project.strategy.actionBindings.forEach((binding, index) => {
        const base = `$.strategy.actionBindings[${index}]`;
        if (!isRecord(binding)) { issues.push(issue(base, "Strategy action binding must be an object")); return; }
        if (typeof binding.semanticTag !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(binding.semanticTag)) issues.push(issue(`${base}.semanticTag`, "Strategy semantic tag must be lowercase kebab-case"));
        else if (bindingTags.has(binding.semanticTag)) issues.push(issue(`${base}.semanticTag`, "Strategy semantic tags must be unique"));
        else bindingTags.add(binding.semanticTag);
        if (typeof binding.commandId !== "string" || !binding.commandId.trim()) issues.push(issue(`${base}.commandId`, "Strategy command ID is required"));
      });
    }
  }

  return { ok: issues.every((item) => item.severity !== "error"), issues };
}

export function validateProject(project: unknown): ValidationResult {
  try {
    return validateProjectInner(project);
  } catch {
    return { ok: false, issues: [issue("$", "Project contains an unreadable value")] };
  }
}

/** Editable source can contain an unfinished path; planning and export remain strict. */
export function validateProjectSource(project: unknown): ValidationResult {
  try {
    return validateProjectInner(project, true);
  } catch {
    return { ok: false, issues: [issue("$", "Project contains an unreadable value")] };
  }
}
