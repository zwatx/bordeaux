export type DriveType = "swerve" | "tank";

export type SegmentType = "bezier" | "line" | "arc" | "clothoid";
export type HeadingMode = "manual" | "tangent" | "targets";
export type SegmentHeadingMode = HeadingMode | "lookAt";
export type FollowMode = "time" | "position";

export interface ControlPoint {
  x: number;
  y: number;
}

export interface RobotConfig {
  drive: DriveType;
  w: number;
  l: number;
  /** Overall robot height. Omitted on migrated projects where it is unknown. */
  heightM?: number;
  /**
   * Convex bumper footprint in robot-local meters (+X forward, +Y left).
   * Omission preserves the centered rectangle defined by l and w.
   */
  footprint?: {
    kind: "polygon";
    verticesM: ControlPoint[];
  };
  /** Editor hint used to preserve parameterized footprint controls across saves. */
  footprintPreset?:
    | { kind: "round"; vertices: number }
    | { kind: "trapezoid"; frontWidthM: number; rearWidthM: number }
    | { kind: "custom" };
  /** Optional strategy-facing mechanism details used only by agent-assisted planning. */
  planning?: RobotPlanningProfile;
  /** Optional drivetrain inputs used to derive the free chassis speed. */
  driveModel?: {
    motorId: string;
    motorFreeRpm: number;
    motorMaxTorqueNm?: number;
    motorCount?: number;
    gearRatio: number;
    wheelDiameterM: number;
    massKg?: number;
    moiKgM2?: number;
    wheelbaseM?: number;
    trackwidthM?: number;
    wheelFrictionCoefficient?: number;
  };
  maxSpeed: number;
}

export interface RobotIntakeProfile {
  /** Human-readable mechanism name, such as "Front intake". */
  name: string;
  /** Intake center in the robot-local frame (+X forward, +Y left). */
  centerM: ControlPoint;
  /** Outward collection direction relative to robot +X; front is 0 degrees. */
  directionDeg: number;
  /** Effective FUEL capture width at the intake opening. */
  captureWidthM: number;
  /** Fastest chassis speed the team trusts while collecting. */
  maxCollectSpeedMps: number;
}

export interface RobotShooterProfile {
  /** Direction the shooter fires relative to robot +X; front is 0 degrees. */
  directionDeg: number;
  /** Whether a shooting pose must orient this direction toward its target. */
  requiresTargetFacing: boolean;
  preferredRangeM?: number;
}

export interface RobotPlanningProfile {
  intake?: RobotIntakeProfile;
  shooter?: RobotShooterProfile;
  /** Team-authored constraints or strategy details not captured by structured fields. */
  notes?: string;
}

export interface TurnInPlace {
  headingDeg: number;
  direction?: "shortest" | "clockwise" | "counterclockwise";
}

export interface JiggleAction {
  distanceM: number;
  strokes: number;
  startDeg: number;
  stepDeg: number;
  /** Duration of one complete outbound-and-return stroke. */
  strokeTimeS: number;
}

export type HeadingTransitionPlacement = "before" | "split" | "after";

export interface HeadingTransition {
  /** Which adjacent segment provides distance for the heading-law blend. */
  placement?: HeadingTransitionPlacement;
  /** @deprecated Legacy files may contain this; planning now couples translation and heading. */
  rotationPriority?: "heading" | "translation";
  /** Total path length available for the minimum-jerk blend. */
  distanceM?: number;
}

export interface Waypoint {
  x: number;
  y: number;
  /** Project-local shared x/y position; heading and tangent handles remain local. */
  positionLink?: string;
  /** Opt-in name that exposes this waypoint in the shared-position picker. */
  positionName?: string;
  theta: number;
  thetaOn: boolean;
  linked: boolean;
  stop: boolean;
  wait?: number;
  corner?: boolean;
  segType?: SegmentType;
  /** Heading law for the outgoing segment. Omitted to inherit PathDoc.headingMode. */
  segmentHeadingMode?: SegmentHeadingMode;
  /** Robot-side following policy for the outgoing segment. Omitted to inherit PathDoc.followMode. */
  segmentFollowMode?: FollowMode;
  /** Field point continuously faced by the outgoing segment when segmentHeadingMode is lookAt. */
  segmentLookAt?: ControlPoint;
  /** @deprecated Heading-law transitions are automatic at the waypoint. */
  headingTransition?: HeadingTransition;
  /** Stationary angular move performed after arriving at this stopped waypoint. */
  turnInPlace?: TurnInPlace;
  /** Rapid terminal translation action expanded into samples without authored waypoints. */
  jiggle?: JiggleAction;
  prevC: ControlPoint;
  nextC: ControlPoint;
}

export interface RotationTarget {
  f: number;
  deg: number;
  anchor?: "param" | "dist";
  d?: number;
}

export interface Marker {
  id?: string;
  f: number;
  name: string;
  cmd?: string;
  invocation?: CommandInvocation;
  /** Requested endpoint action retained until an authoritative command is bound. */
  actionIntent?: {
    semanticTag: string;
    description: string;
  };
  group?: "sequential" | "parallel" | "deadline";
  schedule?: EventSchedule;
  anchor?: "param" | "dist";
  d?: number;
}

export interface EventSchedule {
  /** Time is backwards-compatible; position uses measured robot progress. */
  trigger?: "time" | "position";
  /** Omission executes once. Repetition starts when the marker becomes due. */
  repeatEveryS?: number;
  /** Absolute path time after which a pending or repeated event expires. */
  endTimeS?: number;
  /** Stable robot-side predicate ID. */
  conditionId?: string;
}

export type CommandArgumentValue =
  | null
  | boolean
  | number
  | string
  | CommandArgumentValue[]
  | { [key: string]: CommandArgumentValue };

export interface CommandInvocation {
  commandId: string;
  arguments: Record<string, CommandArgumentValue>;
  cancelOnPathEnd?: boolean;
}

export type RobotValueSchemaKind =
  | "boolean"
  | "integer"
  | "integerString"
  | "decimalString"
  | "number"
  | "string"
  | "enum"
  | "array"
  | "map"
  | "optional"
  | "object"
  | "opaque";

export interface RobotValueField {
  name: string;
  schema: RobotValueSchema;
}

export interface RobotValueSchema {
  kind: RobotValueSchemaKind;
  valueType: string;
  enumValues?: string[];
  element?: RobotValueSchema;
  value?: RobotValueSchema;
  fields?: RobotValueField[];
}

export interface RobotCommandParameter {
  name: string;
  label?: string;
  description?: string;
  unit?: string;
  defaultValue?: CommandArgumentValue;
  min?: number | string;
  max?: number | string;
  valueType: string;
  role: "argument" | "dependency";
  schema: RobotValueSchema;
}

/** A command result available after completion; metadata alone does not authorize robot execution. */
export interface RobotCommandOutput {
  name: string;
  label?: string;
  description?: string;
  unit?: string;
  schema: RobotValueSchema;
  min?: number | string;
  max?: number | string;
  /** Saved NI connector terminal identity, separate from its display caption. */
  terminalNumber?: number;
}

export interface RobotCommandDescriptor {
  id: string;
  label: string;
  description?: string;
  /** Team-authored natural-language aliases from the generated catalog. */
  aliases?: string[];
  /** Explicit capabilities such as shoot-fuel; never inferred from the label. */
  semanticTags?: string[];
  ownerType: string;
  member: string;
  kind: "constructor" | "factory";
  confidence: "confirmed" | "inferred";
  runtimeReady?: boolean;
  /** NI-inspected command lifecycle; caller-owned dispatch is required for execution. */
  labviewLegacy?: true;
  /** Saved NI connector evidence for file serialization; never execution authority. */
  labviewConnector?: {
    labviewVersion: string; applicationContext: "My Computer"; target: string; file: string;
    terminalNumbers: number[]; directions: number[]; requirements: number[]; captions: string[];
    typeXml: string[]; extendedInfo: unknown[]; defaults: Record<string, unknown>;
  };
  parameters: RobotCommandParameter[];
  outputs?: RobotCommandOutput[];
  source: {
    file: string;
    line: number;
  };
}

/** A generated robot predicate that can be used by routine decisions and event schedules. */
export interface RobotConditionDescriptor {
  id: string;
  label: string;
  description?: string;
  /** Team-authored natural-language aliases from the generated catalog. */
  aliases?: string[];
  /** Explicit capabilities such as game-piece; never inferred from the label. */
  semanticTags?: string[];
  ownerType: string;
  member: string;
  source: {
    file: string;
    line: number;
  };
}

/** A Bordeaux-owned routine capability with a closed, versioned contract. */
export interface RobotBuiltInDescriptor {
  id: "bordeaux.wait";
  kind: "wait";
  label: "Wait";
  description: "Pause the routine before its next step.";
  parameters: [RobotCommandParameter];
}

export interface RobotTrajectoryGeneratorLimits {
  timeoutMs: number;
  maxSamples: number;
  maxDurationS: number;
  maxDistanceM: number;
  maxVelocityMps: number;
  maxAccelerationMps2: number;
  maxCentripetalAccelerationMps2: number;
  maxAngularVelocityRadps: number;
  maxAngularAccelerationRadps2: number;
  minClearanceM: number;
}

/** A team-owned runtime trajectory generator with a fully bounded output contract. */
export interface RobotTrajectoryGeneratorDescriptor {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  semanticTags?: string[];
  ownerType: string;
  member: string;
  inputs: RobotCommandParameter[];
  preview: { kind: "runtimeDynamic" };
  fallbackPolicy: "safeStopOnly" | "validatedBranch";
  limits: RobotTrajectoryGeneratorLimits;
  source: { file: string; line: number };
}

/** Disk source inventory only. A VI here is not a verified runtime handler. */
export interface LabviewProjectDiscovery {
  projectFile: string;
  targets: Array<{ name: string; type: string }>;
  items: Array<{
    name: string;
    type: string;
    target: string;
    projectPath: string;
    /** Path relative to the selected project directory; explicit references can be outside it. */
    file?: string;
    status: "present" | "missing" | "unsupported";
    reason?: string;
    origin: "project" | "autoFolder" | "library";
  }>;
  viCount: number;
  truncated: boolean;
  /** Compatibility requirements, not evidence that a discovered VI implements them. */
  commandContract: { kind: "legacy-status-pair"; status: "requires-declaration"; description: string };
  inspection?: {
    status: "available" | "cached" | "unavailable" | "stale";
    /** Inspection instance only. Item target names describe project membership. */
    applicationContext?: "My Computer";
    inspectedAt?: string;
    commandCount: number;
    unsupported: Array<{ file: string; target: string; reason: string }>;
    reason?: string;
  };
}

export interface RobotCommandCatalog {
  runtime?: "labview";
  labviewDiscovery?: LabviewProjectDiscovery;
  projectName: string;
  sourceFileCount: number;
  scannedAt: string;
  source?: "source" | "generated" | "mixed";
  runtimeCommandCount?: number;
  generatedSchemaVersion?: "1.0" | "1.1" | "1.2" | "1.3";
  catalogId?: string;
  supportVersion?: string;
  catalogHash?: string;
  /** Canonical command-semantics fingerprint supplied by the desktop process. */
  semanticFingerprint?: string;
  authoritative?: boolean;
  commands: RobotCommandDescriptor[];
  /** Empty for a legacy generated 1.0 command-only catalog. */
  conditions?: RobotConditionDescriptor[];
  /** Bordeaux-owned built-ins from the generated catalog's semantic identity. */
  builtIns?: RobotBuiltInDescriptor[];
  /** Team-owned runtime trajectory generators. Present only in generated schema 1.3. */
  trajectoryGenerators?: RobotTrajectoryGeneratorDescriptor[];
  warnings: string[];
}

export interface RobotProjectBookmarkSummary {
  id: string;
  /** Display-only parent location. Selection still uses the main-owned bookmark id. */
  locationHint?: string;
  projectName: string;
  folderName: string;
  lastLinkedAt: string;
}

export interface RobotIntegrationStatus {
  runtime?: "labview";
  installed: boolean;
  supportVersion?: string;
  generatedCatalog: boolean;
  catalogHash?: string;
  buildFile: "bordeaux-catalog.json";
  wrapperAvailable: boolean;
}

export interface ConstraintRange {
  anchor: "param" | "dist" | "wp";
  f0: number;
  f1: number;
  d0?: number;
  d1?: number;
  w0?: number;
  w1?: number;
  /** Local fraction within segment w0/w1. Omitted on legacy whole-waypoint spans. */
  t0?: number;
  t1?: number;
  /** Omitted limits inherit the path constraints. */
  maxVel?: number;
  maxAccel?: number;
  maxDecel?: number;
  maxAngVel?: number;
  maxAngAccel?: number;
  /** @deprecated Legacy files may contain this; planning now couples translation and heading. */
  rotationPriority?: "heading" | "translation";
  name?: string;
}

export interface PathDoc {
  id: string;
  name: string;
  waypoints: Waypoint[];
  targets: RotationTarget[];
  markers: Marker[];
  ranges: ConstraintRange[];
  constraints: PathConstraints;
  headingMode?: HeadingMode;
  /** Robot-side following policy. Omitted for backwards-compatible time following. */
  followMode?: FollowMode;
  folderId?: string;
  driveBackward?: boolean;
  startVel: number;
  goalVel: number;
  exportable?: boolean;
  /** Internal derived planning geometry only, never permitted on authored source. */
  routeRequiredPointIndices?: number[];
  /** Authored corridor and explicit selection; project plannerId never selects an artifact. */
  optimization?: {
    corridorM?: number;
    accepted?: AcceptedTrajectory;
    /** Retained on explicit route Apply; active accepted always takes precedence. */
    legacyAccepted?: AcceptedTrajectory & { version: 1 };
  };
}

/** Exact selected samples; v1 retains its original corridor contract. */
export interface AcceptedTrajectory {
  version: 1 | 2;
  inputKey: string;
  samplesPerSegment: number;
  result: PlannerResult;
}

export interface RouteGeometry {
  version: 1;
  /** Geometry-owned curvature smoothing, independent of later seed editing modes. */
  knots: Array<ControlPoint & { prevC: ControlPoint; nextC: ControlPoint; smooth?: boolean }>;
  /** Ordered generated-knot index for each required source waypoint. */
  requiredPointIndices: number[];
}

export interface PathFolder {
  id: string;
  name: string;
}

export interface PathConstraints {
  maxVel: number;
  maxAccel: number;
  maxDecel: number;
  /** Lateral acceleration used to cap speed from path curvature. Omission preserves maxAccel behavior. */
  maxCentripetalAccel?: number;
  maxAngVel: number;
  maxAngAccel: number;
  maxAngDecel?: number;
  maxJerk?: number;
  maxAngJerk?: number;
}

export interface RoutineCommandOutputRoute {
  id: string;
  label: string;
  operator: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "otherwise";
  value?: boolean | string | number;
  nodes: RoutineNode[];
}

export interface RoutineCommandOutputBranch {
  output: string;
  /** Snapshot of the selected output type; retained when the source is unavailable. */
  schema: RobotValueSchema;
  /** Evaluated in order, with the first matching route selected. */
  routes: RoutineCommandOutputRoute[];
}

export interface RoutinePredicate { source: "condition"; conditionId: string }
export interface RoutineOutputStop {
  source: "output";
  nodeId: string;
  output: string;
  schema?: RobotValueSchema;
  operator: "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
  value?: boolean | string | number;
}
export interface RoutineCommandEnds {
  endWhen?: RoutinePredicate;
  timeoutS?: number;
  onTimeout?: "continue" | "endRoutine";
}
export interface RoutineWaitEnds { endWhen?: RoutinePredicate }
export interface RoutineRepeatNode {
  id: string;
  type: "repeat";
  times: number;
  until?: RoutinePredicate | RoutineOutputStop;
  nodes: RoutineNode[];
}
export interface RoutineEndNode { id: string; type: "end"; scope: "routine" | "repeat" }

export interface RoutineFunctionNode {
  id: string;
  type: "function";
  cat: "command" | "terminate" | "sequence" | "generate" | "velocity";
  title?: string;
  trigger?: string;
  note?: string;
  scale?: number;
  funcRef?: string;
  op?: string;
  target?: string;
  /** Generated Robot command invoked between path steps. */
  invocation?: CommandInvocation;
  /** Local authoring and preview only until the robot execution contract supports outputs. */
  outputBranch?: RoutineCommandOutputBranch;
  ends?: RoutineCommandEnds;
}

export interface RoutinePathNode {
  id: string;
  type: "path";
  ref: string;
}

export interface RoutineDecisionNode {
  id: string;
  type: "decision";
  cond: string;
  thenLabel: string;
  elseLabel: string;
  then: RoutineNode[];
  else: RoutineNode[];
}

export interface RoutineBuiltInNode {
  id: string;
  type: "builtin";
  builtinId: "bordeaux.wait";
  arguments: { durationS: number };
  ends?: RoutineWaitEnds;
}

export interface RoutineFallbackDecisionNode extends Omit<RoutineDecisionNode, "then" | "else"> {
  then: RoutineFallbackNode[];
  else: RoutineFallbackNode[];
}

export type RoutineFallbackNode = RoutineFunctionNode | RoutinePathNode | RoutineFallbackDecisionNode | RoutineBuiltInNode;

export interface RoutineGeneratedTrajectoryNode {
  id: string;
  type: "generatedTrajectory";
  generatorId: string;
  arguments: Record<string, CommandArgumentValue>;
  fallback:
    | { type: "safeStop" }
    | { type: "branch"; nodes: RoutineFallbackNode[] };
}

export type RoutineNode = RoutineFunctionNode | RoutinePathNode | RoutineDecisionNode | RoutineBuiltInNode | RoutineGeneratedTrajectoryNode | RoutineRepeatNode | RoutineEndNode;

export interface AutonomousRoutine {
  /** Stable project-local identity. */
  id: string;
  name: string;
  nodes: RoutineNode[];
}

export type StrategyLocation = {
  id: string;
  name: string;
  aliases?: string[];
  headingDeg?: number;
} & (
  | { kind: "pose"; x: number; y: number }
  | { kind: "region"; bounds: { xMin: number; xMax: number; yMin: number; yMax: number } }
);

export interface StrategyActionBinding {
  semanticTag: string;
  commandId: string;
}

/** Optional team-owned vocabulary which supplements the season field pack. */
export interface ProjectStrategyOverlay {
  locations?: StrategyLocation[];
  actionBindings?: StrategyActionBinding[];
}

export interface PathEndpointLink {
  id: string;
  fromPathId: string;
  toPathId: string;
}

/** Durable editor context which is safe to ignore on another machine. */
export interface ProjectEditorState {
  activePathId?: string;
  robotProjectBookmarkId?: string;
  /** Relative to this project folder. null means unresolved: explicitly relink, never use the legacy bookmark. */
  labviewProjectPath?: string | null;
  unitSystem?: "metric" | "imperial";
}

export interface FieldReference {
  id: string;
  revision: string;
  coordinateSchemaId: string;
}

export interface FieldMigrationRecord {
  source: "legacy-unpinned";
  assigned: FieldReference;
}

export interface BordeauxProject {
  schemaVersion: string;
  field: FieldReference;
  fieldMigration?: FieldMigrationRecord;
  name: string;
  robot: RobotConfig;
  paths: PathDoc[];
  pathFolders?: PathFolder[];
  /** Keeps one path's end pose synchronized with another path's start pose. */
  pathLinks: PathEndpointLink[];
  routines: AutonomousRoutine[];
  activeRoutineId: string;
  plannerId: TrajectoryPlannerId;
  strategy?: ProjectStrategyOverlay;
  editor?: ProjectEditorState;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export type TrajectoryPlannerId = "profiledSpline" | "optimizedTrajectory";

export interface PlannerInput {
  path: PathDoc;
  robot: RobotConfig;
  field?: FieldReference;
  samplesPerSegment?: number;
  smoothingPasses?: number;
}

export interface TrajectorySample {
  i: number;
  t: number;
  s: number;
  f: number;
  x: number;
  y: number;
  headingRad: number;
  velocityMps: number;
  accelerationMps2: number;
  angularVelocityRadps: number;
  curvatureInvM: number;
}

export interface BdxMarker {
  id: string;
  name: string;
  command: string | null;
  invocation?: CommandInvocation;
  group: string | null;
  timeS: number;
  fraction: number;
}

export interface BdxPath {
  id: string;
  name: string;
  planner: TrajectoryPlannerId;
  totalTimeS: number;
  totalDistanceM: number;
  samples: TrajectorySample[];
  markers: BdxMarker[];
  diagnostics: ValidationIssue[];
  optimization?: PlannerOptimizationDiagnostics;
}

export interface PlannerStationaryAction {
  kind: "turn" | "jiggle" | "wait";
  waypointIndex: number;
  fraction: number;
  startTimeS: number;
  endTimeS: number;
  strokeDurationS?: number;
}

export interface PlannerResult {
  planner: TrajectoryPlannerId;
  totalTimeS: number;
  totalDistanceM: number;
  samples: TrajectorySample[];
  /** Structural authored-waypoint arrivals. Internal planner metadata; not part of BDX exports. */
  waypointSampleIndices?: number[];
  markers: BdxMarker[];
  diagnostics: ValidationIssue[];
  optimization?: PlannerOptimizationDiagnostics;
  /** Internal timing metadata used to keep renderer playback identical to exported samples. */
  stationaryActions?: PlannerStationaryAction[];
  /** Internal final-preview geometry; export schemas select trajectory fields explicitly. */
  optimizedPath?: PathDoc;
  /** Versioned solver-owned geometry, separate from required source points. */
  routeGeometry?: RouteGeometry;
}

export interface TrajectoryPlanner {
  id: TrajectoryPlannerId;
  generate(input: PlannerInput): PlannerResult;
}

export interface PlannerOptimizationDiagnostics {
  /** Qualification of the actual authored Normal, never inferred from candidate feasibility. */
  seedStatus?: "unknown" | "valid" | "invalid";
  plannerUsed: TrajectoryPlannerId;
  status?: "optimal" | "feasible" | "equivalent" | "invalid-input" | "infeasible" | "cancelled" | "internal-error";
  iterations?: number;
  refinementPasses?: number;
  validatedPoints?: number;
  activeConstraints?: string[];
  solveTimeMs: number;
  totalTimeS: number;
  maxVelocityMps: number;
  maxAccelerationMps2: number;
  constraintViolations: number;
  fallback: boolean;
  fallbackReason?: string;
  optimizationClass?: "fixed-geometry" | "corridor" | "route";
  budgetTier?: "common" | "stress" | "hard";
  budgetMs?: number;
  evaluations?: number;
  validatedCandidates?: number;
  rejectedCandidates?: number;
  rejectionReasons?: { reason: string; count: number }[];
  termination?: "completed" | "work-budget" | "time-budget" | "cancelled" | "unsupported" | "invalid-baseline";
  baselineTimeS?: number;
  gainS?: number;
  maxDeviationM?: number;
  minimumClearanceM?: number;
}

export interface BdxExport {
  schemaVersion: string;
  generator: "bordeaux";
  field: FieldReference;
  units: {
    distance: "meters";
    time: "seconds";
    angle: "radians";
    velocity: "meters_per_second";
    acceleration: "meters_per_second_squared";
  };
  robot: {
    drive: DriveType;
    widthM: number;
    lengthM: number;
    heightM?: number;
    footprint?: RobotConfig["footprint"];
    maxSpeedMps: number;
  };
  paths: BdxPath[];
  routine: AutonomousRoutine | null;
}

/** Desktop delivery support; file export does not imply an installed robot receiver. */
export interface RobotDeliveryCapabilities {
  fileTransfer?: boolean;
  pathPush: boolean;
  routinePush: boolean;
}
