import { FIELD_H, FIELD_W, FIELD_X_MAX, FIELD_Y_MAX, WELDED_FIELD_W, WELDED_FIELD_H, centerAndyMarkPoint, rotateBlueOriginPoint } from "../math/fieldBounds";
import type { FieldLandmark, FieldPack, FieldPoint, FieldRect } from "./types";
import { FIELD_IMAGE } from "./imageCalibration";

export const REBUILT_2026_FIELD_REVISION = "2026-manual-tu19-andymark-1";
export const WELDED_FIELD_REVISION = "2026-manual-tu19-welded-4";
export const BLUE_ORIGIN_FIELD_SCHEMA_ID = "wpilib-blue-origin/2026-welded/1";
export const BORDEAUX_FIELD_COORDINATE_SCHEMA_ID = "wpilib-center-origin/2026-andymark/1";
export const ACTIVE_FIELD_REFERENCE = {
  id: "2026-rebuilt",
  revision: REBUILT_2026_FIELD_REVISION,
  coordinateSchemaId: BORDEAUX_FIELD_COORDINATE_SCHEMA_ID,
} as const;
export const REBUILT_2026_FIELD_LENGTH_M = FIELD_W;
export const REBUILT_2026_FIELD_WIDTH_M = FIELD_H;

const WALL_INSET = (WELDED_FIELD_W - FIELD_W) / 2;
const RAIL_INSET = (WELDED_FIELD_H - FIELD_H) / 2;
const BLUE_WALL_X = WALL_INSET;
const RED_WALL_X = WELDED_FIELD_W - WALL_INSET;
const TABLE_RAIL_Y = RAIL_INSET;
const AWAY_RAIL_Y = WELDED_FIELD_H - RAIL_INSET;

// Keep welded interior measurements exactly relative to their center. WPILib's
// v2026.2.1 layouts agree within 2.5 mm there. Express the AndyMark perimeter
// in the same measurement axes so existing geometry can be converted once.

const BLUE_BARRIER_X = 4.02844;
const RED_BARRIER_X = WELDED_FIELD_W - BLUE_BARRIER_X;
const WELDED_TRENCH_OPENING_WIDTH_M = 1.278636;
const TRENCH_OPENING_WIDTH_M = WELDED_TRENCH_OPENING_WIDTH_M - RAIL_INSET;
export const REBUILT_2026_TRENCH_CLEARANCE_M = 22.25 * 0.0254;
const TRENCH_TABLE_Y = WELDED_TRENCH_OPENING_WIDTH_M / 2;
const TRENCH_AWAY_Y = WELDED_FIELD_H - WELDED_TRENCH_OPENING_WIDTH_M / 2;
const BUMP_TABLE_Y = 2.59461;
const BUMP_AWAY_Y = WELDED_FIELD_H - BUMP_TABLE_Y;
const STRUCTURE_DEPTH_M = 1.1938;
const BUMP_DEPTH_M = 1.12776;
const HUB_WIDTH_M = 1.1938;
const HUB_Y_MIN = (WELDED_FIELD_H - HUB_WIDTH_M) / 2;
const BLUE_STRUCTURE_X_MAX = BLUE_BARRIER_X + STRUCTURE_DEPTH_M;
const RED_STRUCTURE_X_MIN = RED_BARRIER_X - STRUCTURE_DEPTH_M;
const BLUE_BUMP_X_MAX = BLUE_BARRIER_X + BUMP_DEPTH_M;
const RED_BUMP_X_MIN = RED_BARRIER_X - BUMP_DEPTH_M;
const NEUTRAL_X_MIN = (WELDED_FIELD_W - 7.1882) / 2;
const NEUTRAL_X_MAX = WELDED_FIELD_W - NEUTRAL_X_MIN;
const INITIAL_FUEL_DEPTH_M = 72 * 0.0254;
const INITIAL_FUEL_WIDTH_M = 206 * 0.0254;

export function officialToAppPoint(point: FieldPoint): FieldPoint {
  return { ...point };
}

export function officialToAppRect(bounds: FieldRect): FieldRect {
  return { ...bounds };
}

function centerMeasuredPoint(point: FieldPoint): FieldPoint {
  const centered = rotateBlueOriginPoint(point);
  return {
    x: point.x === BLUE_WALL_X ? FIELD_X_MAX : point.x === RED_WALL_X ? -FIELD_X_MAX : centered.x,
    y: point.y === TABLE_RAIL_Y ? FIELD_Y_MAX : point.y === AWAY_RAIL_Y ? -FIELD_Y_MAX : centered.y,
  };
}

function centerRect(bounds: FieldRect): FieldRect {
  const min = centerMeasuredPoint({ x: bounds.xMax, y: bounds.yMax });
  const max = centerMeasuredPoint({ x: bounds.xMin, y: bounds.yMin });
  return { xMin: min.x, xMax: max.x, yMin: min.y, yMax: max.y };
}

export function appToOfficialPoint(point: FieldPoint): FieldPoint {
  return { ...point };
}

export function appToAllianceViewPoint(point: FieldPoint, allianceView: "blue" | "red"): FieldPoint {
  return allianceView === "red" ? { x: -point.x, y: -point.y } : { ...point };
}

function pointLandmark(
  id: string,
  name: string,
  aliases: string[],
  point: FieldPoint,
  allianceOwner?: "blue" | "red",
  traversal?: "trench" | "bump",
  allianceSide?: "left" | "right",
): FieldLandmark {
  return {
    id, name, aliases, kind: traversal ? "portal" : "point", point, allianceOwner, traversal, allianceSide,
    behavior: traversal === "trench" ? "overhead" : traversal === "bump" ? "traversable" : "interaction",
    ...(traversal === "trench" ? { openingWidthM: TRENCH_OPENING_WIDTH_M, clearanceHeightM: REBUILT_2026_TRENCH_CLEARANCE_M } : {}),
    ...(traversal === "bump" ? { openingWidthM: 1.8542 } : {}),
  };
}

function regionLandmark(id: string, name: string, aliases: string[], bounds: FieldRect): FieldLandmark {
  return { id, name, aliases, kind: "region", bounds };
}

function lineLandmark(id: string, name: string, aliases: string[], start: FieldPoint, end: FieldPoint, allianceOwner?: "blue" | "red"): FieldLandmark {
  return { id, name, aliases, kind: "line", line: { start, end }, point: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, allianceOwner, behavior: "line" };
}

function obstacle(id: string, name: string, aliases: string[], bounds: FieldRect): FieldLandmark {
  return { id, name, aliases, kind: "obstacle", bounds, behavior: "solid", navigable: false };
}

function descriptiveLandmark(id: string, name: string, aliases: string[], description: string, extra: Partial<FieldLandmark> = {}): FieldLandmark {
  return { id, name, aliases, kind: "point", behavior: "interaction", navigable: false, description, ...extra };
}

const measuredNeutralZone: FieldRect = {
  xMin: NEUTRAL_X_MIN,
  xMax: NEUTRAL_X_MAX,
  yMin: TABLE_RAIL_Y,
  yMax: AWAY_RAIL_Y,
};

/** Approximate pre-MATCH FUEL corral from Game Manual section 6.3.4.1. */
const measuredFuelRegion: FieldRect = {
  xMin: WELDED_FIELD_W / 2 - INITIAL_FUEL_DEPTH_M / 2,
  xMax: WELDED_FIELD_W / 2 + INITIAL_FUEL_DEPTH_M / 2,
  yMin: WELDED_FIELD_H / 2 - INITIAL_FUEL_WIDTH_M / 2,
  yMax: WELDED_FIELD_H / 2 + INITIAL_FUEL_WIDTH_M / 2,
};

const hubLandmarks = [
  obstacle("blue-hub", "Blue HUB", ["blue hub", "blue goal"], { xMin: BLUE_BARRIER_X, xMax: BLUE_STRUCTURE_X_MAX, yMin: HUB_Y_MIN, yMax: HUB_Y_MIN + HUB_WIDTH_M }),
  obstacle("red-hub", "Red HUB", ["red hub", "red goal"], { xMin: RED_STRUCTURE_X_MIN, xMax: RED_BARRIER_X, yMin: HUB_Y_MIN, yMax: HUB_Y_MIN + HUB_WIDTH_M }),
];

const aprilTagData = [
  [1, 11.8779798, 7.4247756, 0.889, 180], [2, 11.9154194, 4.63804, 1.12395, 90], [3, 11.3118646, 4.3902376, 1.12395, 180], [4, 11.3118646, 4.0346376, 1.12395, 180],
  [5, 11.9154194, 3.4312352, 1.12395, -90], [6, 11.8779798, 0.6444996, 0.889, 180], [7, 11.9528844, 0.6444996, 0.889, 0], [8, 12.2710194, 3.4312352, 1.12395, -90],
  [9, 12.5191774, 3.6790376, 1.12395, 0], [10, 12.5191774, 4.0346376, 1.12395, 0], [11, 12.2710194, 4.63804, 1.12395, 90], [12, 11.9528844, 7.4247756, 0.889, 0],
  [17, 4.6630844, 0.6444996, 0.889, 0], [18, 4.6256194, 3.4312352, 1.12395, -90], [19, 5.2291742, 3.6790376, 1.12395, 0], [20, 5.2291742, 4.0346376, 1.12395, 0],
  [21, 4.6256194, 4.63804, 1.12395, 90], [22, 4.6630844, 7.4247756, 0.889, 0], [23, 4.5881798, 7.4247756, 0.889, 180], [24, 4.2700194, 4.63804, 1.12395, 90],
  [25, 4.0218614, 4.3902376, 1.12395, 180], [26, 4.0218614, 4.0346376, 1.12395, 180], [27, 4.2700194, 3.4312352, 1.12395, -90], [28, 4.5881798, 0.6444996, 0.889, 180],
] as const;

const andyMarkWallTags = [
  [13, 16.499332, 7.391908, 0.55245, 180], [14, 16.499332, 6.960108, 0.55245, 180],
  [15, 16.4989764, 4.3124882, 0.55245, 180], [16, 16.4989764, 3.8806882, 0.55245, 180],
  [29, 0.0136906, 0.6507734, 0.55245, 0], [30, 0.0136906, 1.0825734, 0.55245, 0],
  [31, 0.0140462, 3.7301932, 0.55245, 0], [32, 0.0140462, 4.1619932, 0.55245, 0],
] as const;

function aprilTagAttachment(id: number): string {
  if ([1, 6, 7, 12, 17, 22, 23, 28].includes(id)) return "TRENCH";
  if ((id >= 2 && id <= 5) || (id >= 8 && id <= 11) || (id >= 18 && id <= 21) || (id >= 24 && id <= 27)) return "HUB";
  if ([13, 14, 29, 30].includes(id)) return "OUTPOST";
  return "TOWER WALL";
}

const aprilTagLandmarks: FieldLandmark[] = [...aprilTagData, ...andyMarkWallTags].sort(([a], [b]) => a - b).map(([id, x, y, elevationM, headingDeg]) => ({
  id: `apriltag-${id}`,
  name: `AprilTag ${id}`,
  aliases: [`april tag ${id}`, `apriltag ${id}`, `tag ${id}`],
  kind: "point",
  behavior: "interaction",
  navigable: false,
  point: { x, y },
  elevationM,
  headingDeg,
  attachedTo: aprilTagAttachment(id),
  allianceOwner: id <= 16 ? "red" : "blue",
  description: "WPILib 2026 fiducial pose. The point is on the tag face and is unsuitable as a robot destination.",
}));

const landmarks: FieldLandmark[] = [
  regionLandmark("field-carpet", "FIELD carpet", ["field", "field carpet", "playing field"], { xMin: BLUE_WALL_X, xMax: RED_WALL_X, yMin: TABLE_RAIL_Y, yMax: AWAY_RAIL_Y }),
  regionLandmark("blue-alliance-zone", "Blue ALLIANCE ZONE", ["blue alliance zone", "blue side"], { xMin: BLUE_WALL_X, xMax: BLUE_BARRIER_X, yMin: TABLE_RAIL_Y, yMax: AWAY_RAIL_Y }),
  regionLandmark("red-alliance-zone", "Red ALLIANCE ZONE", ["red alliance zone", "red side"], { xMin: RED_BARRIER_X, xMax: RED_WALL_X, yMin: TABLE_RAIL_Y, yMax: AWAY_RAIL_Y }),
  regionLandmark("neutral-zone", "NEUTRAL ZONE", ["neutral zone", "neutral"], measuredNeutralZone),
  regionLandmark("initial-fuel-region", "Initial NEUTRAL ZONE FUEL region", ["initial fuel region", "fuel staging region", "neutral fuel band", "starting fuel cloud"], measuredFuelRegion),
  lineLandmark("center-line", "CENTER LINE", ["center line", "midfield", "middle of the field"], { x: WELDED_FIELD_W / 2, y: TABLE_RAIL_Y }, { x: WELDED_FIELD_W / 2, y: AWAY_RAIL_Y }),
  lineLandmark("blue-robot-starting-line", "Blue ROBOT STARTING LINE", ["blue starting line", "blue alliance line"], { x: BLUE_BARRIER_X, y: TABLE_RAIL_Y }, { x: BLUE_BARRIER_X, y: AWAY_RAIL_Y }, "blue"),
  lineLandmark("red-robot-starting-line", "Red ROBOT STARTING LINE", ["red starting line", "red alliance line"], { x: RED_BARRIER_X, y: TABLE_RAIL_Y }, { x: RED_BARRIER_X, y: AWAY_RAIL_Y }, "red"),
  lineLandmark("scoring-table-guardrail", "Scoring-table guardrail", ["scoring table side", "table guardrail", "table side"], { x: BLUE_WALL_X, y: TABLE_RAIL_Y }, { x: RED_WALL_X, y: TABLE_RAIL_Y }),
  lineLandmark("away-guardrail", "Non-scoring-table guardrail", ["non scoring table side", "away guardrail", "away side"], { x: BLUE_WALL_X, y: AWAY_RAIL_Y }, { x: RED_WALL_X, y: AWAY_RAIL_Y }),
  lineLandmark("blue-alliance-wall", "Blue ALLIANCE WALL", ["blue wall", "blue driver wall"], { x: BLUE_WALL_X, y: TABLE_RAIL_Y }, { x: BLUE_WALL_X, y: AWAY_RAIL_Y }, "blue"),
  lineLandmark("red-alliance-wall", "Red ALLIANCE WALL", ["red wall", "red driver wall"], { x: RED_WALL_X, y: TABLE_RAIL_Y }, { x: RED_WALL_X, y: AWAY_RAIL_Y }, "red"),
  descriptiveLandmark("alliance-area", "ALLIANCE AREA", ["alliance area"], "Off-field 360 in by 134 in drive-team area. It is official vocabulary but never a robot drive target.", { dimensionsM: { width: 360 * 0.0254, depth: 134 * 0.0254 } }),
  descriptiveLandmark("outpost-area", "OUTPOST AREA", ["outpost area"], "Off-field 71 in by 134 in HUMAN PLAYER area. It is official vocabulary but never a robot drive target.", { dimensionsM: { width: 71 * 0.0254, depth: 134 * 0.0254 } }),
  descriptiveLandmark("human-starting-line", "HUMAN STARTING LINE", ["human starting line"], "Off-field white line 24 in from the ALLIANCE WALL bottom tube. It is not a robot navigation line."),
  pointLandmark("blue-trench-table", "Blue scoring-table-side TRENCH", ["blue table trench", "blue right trench"], { x: BLUE_BARRIER_X, y: TRENCH_TABLE_Y }, "blue", "trench", "right"),
  pointLandmark("blue-trench-away", "Blue non-scoring-table-side TRENCH", ["blue away trench", "blue left trench"], { x: BLUE_BARRIER_X, y: TRENCH_AWAY_Y }, "blue", "trench", "left"),
  pointLandmark("red-trench-table", "Red scoring-table-side TRENCH", ["red table trench", "red left trench"], { x: RED_BARRIER_X, y: TRENCH_TABLE_Y }, "red", "trench", "left"),
  pointLandmark("red-trench-away", "Red non-scoring-table-side TRENCH", ["red away trench", "red right trench"], { x: RED_BARRIER_X, y: TRENCH_AWAY_Y }, "red", "trench", "right"),
  pointLandmark("blue-bump-table", "Blue scoring-table-side BUMP", ["blue table bump", "blue right bump"], { x: BLUE_BARRIER_X, y: BUMP_TABLE_Y }, "blue", "bump", "right"),
  pointLandmark("blue-bump-away", "Blue non-scoring-table-side BUMP", ["blue away bump", "blue left bump"], { x: BLUE_BARRIER_X, y: BUMP_AWAY_Y }, "blue", "bump", "left"),
  pointLandmark("red-bump-table", "Red scoring-table-side BUMP", ["red table bump", "red left bump"], { x: RED_BARRIER_X, y: BUMP_TABLE_Y }, "red", "bump", "left"),
  pointLandmark("red-bump-away", "Red non-scoring-table-side BUMP", ["red away bump", "red right bump"], { x: RED_BARRIER_X, y: BUMP_AWAY_Y }, "red", "bump", "right"),
  { id: "blue-tower-base", name: "Blue TOWER BASE", aliases: ["blue tower", "blue tower base", "blue climb zone"], kind: "region", bounds: { xMin: BLUE_WALL_X, xMax: BLUE_WALL_X + 1.147572, yMin: 3.5392, yMax: 4.5298 }, allianceOwner: "blue", behavior: "climbable" },
  { id: "red-tower-base", name: "Red TOWER BASE", aliases: ["red tower", "red tower base", "red climb zone"], kind: "region", bounds: { xMin: RED_WALL_X - 1.147572, xMax: RED_WALL_X, yMin: 3.5392, yMax: 4.5298 }, allianceOwner: "red", behavior: "climbable" },
  ...(["blue", "red"] as const).flatMap((alliance) => [
    descriptiveLandmark(`${alliance}-tower-low-rung`, `${alliance} TOWER LOW RUNG`, [`${alliance} low rung`], "Climbing rung center 27 in above the carpet.", { allianceOwner: alliance, elevationM: 27 * 0.0254, dimensionsM: { diameter: 1.66 * 0.0254 } }),
    descriptiveLandmark(`${alliance}-tower-mid-rung`, `${alliance} TOWER MID RUNG`, [`${alliance} mid rung`], "Climbing rung center 45 in above the carpet.", { allianceOwner: alliance, elevationM: 45 * 0.0254, dimensionsM: { diameter: 1.66 * 0.0254 } }),
    descriptiveLandmark(`${alliance}-tower-high-rung`, `${alliance} TOWER HIGH RUNG`, [`${alliance} high rung`], "Climbing rung center 63 in above the carpet.", { allianceOwner: alliance, elevationM: 63 * 0.0254, dimensionsM: { diameter: 1.66 * 0.0254 } }),
    descriptiveLandmark(`${alliance}-outpost-chute`, `${alliance} OUTPOST CHUTE`, [`${alliance} chute`], "15-degree HUMAN PLAYER chute feeding the upper OUTPOST opening; not a robot drive target.", { allianceOwner: alliance, dimensionsM: { width: 31.8 * 0.0254, height: 7 * 0.0254 } }),
    descriptiveLandmark(`${alliance}-outpost-corral`, `${alliance} OUTPOST CORRAL`, [`${alliance} corral`], "Lower OUTPOST opening where ROBOTS return FUEL; use the adjacent AprilTag poses for perception, not this label as a drive coordinate.", { allianceOwner: alliance, dimensionsM: { width: 32 * 0.0254, height: 7 * 0.0254 } }),
    descriptiveLandmark(`${alliance}-depot`, `${alliance} DEPOT`, [`${alliance} depot`], "42 in wide by 27 in deep FUEL staging structure along the ALLIANCE WALL. Its 3 in wide steel barriers are solid; exact barrier polygons are intentionally not inferred from a center point.", { allianceOwner: alliance, dimensionsM: { width: 42 * 0.0254, depth: 27 * 0.0254, height: 1.125 * 0.0254 } }),
    ...([1, 2, 3] as const).map((station) => descriptiveLandmark(`${alliance}-driver-station-${station}`, `${alliance} DRIVER STATION ${station}`, [`${alliance} driver station ${station}`, `${alliance} ds ${station}`], "One of three off-field DRIVE TEAM stations in the ALLIANCE WALL; not a robot drive target.", { allianceOwner: alliance, dimensionsM: { height: (36.8 + 42) * 0.0254 } })),
  ]),
  ...(["blue", "red"] as const).flatMap((alliance) => {
    const hub = hubLandmarks.find((item) => item.id === `${alliance}-hub`)!;
    const bounds = hub.bounds!;
    return [
      { ...pointLandmark(`${alliance}-hub-alliance-face`, `${alliance} HUB alliance-wall face`, [`${alliance} hub back face`, `${alliance} hub alliance face`], { x: alliance === "blue" ? bounds.xMin : bounds.xMax, y: (bounds.yMin + bounds.yMax) / 2 }, alliance), navigable: false, description: "Reference point on the solid HUB surface, not a robot pose." },
      { ...pointLandmark(`${alliance}-hub-neutral-face`, `${alliance} HUB neutral-zone face`, [`${alliance} hub front face`, `${alliance} hub neutral face`], { x: alliance === "blue" ? bounds.xMax : bounds.xMin, y: (bounds.yMin + bounds.yMax) / 2 }, alliance), navigable: false, description: "Reference point on the solid HUB surface, not a robot pose." },
      { ...pointLandmark(`${alliance}-hub-table-face`, `${alliance} HUB scoring-table face`, [`${alliance} hub table face`], { x: (bounds.xMin + bounds.xMax) / 2, y: bounds.yMin }, alliance), navigable: false, description: "Reference point on the solid HUB surface, not a robot pose." },
      { ...pointLandmark(`${alliance}-hub-away-face`, `${alliance} HUB non-scoring-table face`, [`${alliance} hub away face`], { x: (bounds.xMin + bounds.xMax) / 2, y: bounds.yMax }, alliance), navigable: false, description: "Reference point on the solid HUB surface, not a robot pose." },
    ];
  }),
  ...aprilTagLandmarks,
  ...hubLandmarks,
];

export const REBUILT_2026_NEUTRAL_ZONE = centerRect(measuredNeutralZone);
export const REBUILT_2026_INITIAL_FUEL_REGION = centerRect(measuredFuelRegion);

const centeredLandmarks = landmarks.map((landmark): FieldLandmark => ({
  ...landmark,
  ...(landmark.point && { point: (andyMarkWallTags.some(([id]) => landmark.id === `apriltag-${id}`)
    ? centerAndyMarkPoint : centerMeasuredPoint)(landmark.point) }),
  ...(landmark.bounds && { bounds: centerRect(landmark.bounds) }),
  ...(landmark.line && { line: {
    start: centerMeasuredPoint(landmark.line.start),
    end: centerMeasuredPoint(landmark.line.end),
  } }),
  ...(landmark.headingDeg !== undefined && { headingDeg: landmark.headingDeg + 180 }),
}));

function crossingPortal(id: string, side: "table" | "away") {
  const landmark = landmarks.find((item) => item.id === id)!;
  const isBlue = landmark.allianceOwner === "blue";
  const isBump = landmark.traversal === "bump";
  const yMin = isBump
    ? landmark.point!.y - landmark.openingWidthM! / 2
    : side === "table" ? TABLE_RAIL_Y : AWAY_RAIL_Y - landmark.openingWidthM!;
  const yMax = isBump
    ? landmark.point!.y + landmark.openingWidthM! / 2
    : side === "table" ? TABLE_RAIL_Y + landmark.openingWidthM! : AWAY_RAIL_Y;
  const xMin = isBlue ? BLUE_BARRIER_X : (isBump ? RED_BUMP_X_MIN : RED_STRUCTURE_X_MIN);
  const xMax = isBlue ? (isBump ? BLUE_BUMP_X_MAX : BLUE_STRUCTURE_X_MAX) : RED_BARRIER_X;
  return {
    id: landmark.id,
    name: landmark.name,
    allianceOwner: landmark.allianceOwner!,
    traversal: landmark.traversal!,
    side,
    allianceSide: landmark.allianceSide!,
    point: rotateBlueOriginPoint(landmark.point!),
    widthM: landmark.openingWidthM!,
    bounds: centerRect({ xMin, xMax, yMin, yMax }),
    depthM: xMax - xMin,
    ...(landmark.clearanceHeightM === undefined ? {} : { clearanceHeightM: landmark.clearanceHeightM }),
  };
}

const crossingBarriers = [
  {
    id: "blue-alliance-barrier",
    allianceOwner: "blue" as const,
    x: rotateBlueOriginPoint({ x: BLUE_BARRIER_X, y: 0 }).x,
    portals: [
      crossingPortal("blue-trench-table", "table"),
      crossingPortal("blue-trench-away", "away"),
      crossingPortal("blue-bump-table", "table"),
      crossingPortal("blue-bump-away", "away"),
    ],
  },
  {
    id: "red-alliance-barrier",
    allianceOwner: "red" as const,
    x: rotateBlueOriginPoint({ x: RED_BARRIER_X, y: 0 }).x,
    portals: [
      crossingPortal("red-trench-table", "table"),
      crossingPortal("red-trench-away", "away"),
      crossingPortal("red-bump-table", "table"),
      crossingPortal("red-bump-away", "away"),
    ],
  },
];

export const REBUILT_2026_FIELD: FieldPack = {
  id: "2026-rebuilt",
  revision: REBUILT_2026_FIELD_REVISION,
  name: "2026 REBUILT presented by Haas (AndyMark)",
  dimensions: { lengthM: FIELD_W, widthM: FIELD_H },
  imageCalibration: FIELD_IMAGE,
  coordinateFrame: "WPILib center origin: +X toward blue, +Y toward the scoring-table guardrail",
  appDisplayTransform: {
    appLengthM: FIELD_W,
    appWidthM: FIELD_H,
    description: "Centered meters; calibrated image projection shows blue on the right",
  },
  authoringInvariants: [
    "Canonical Bordeaux coordinates use the fixed center origin: +X toward blue, +Y toward the scoring table, heading zero along +X and positive headings counterclockwise.",
    "Flip rotates all authored paths 180 degrees in the canonical frame, including headings, handles and look-at points; it is a saved, undoable edit.",
    "Alliance left/right is from that alliance's drivers facing the field: red-left is scoring-table side and blue-left is non-scoring-table side.",
    "A route with different outbound and inbound crossings must use ordered per-leg traversal requirements; one global traversal is invalid.",
    "A swoosh is a typed 180-degree maneuver with explicit turn direction and radius, not an arbitrary coordinate loop.",
    "Initial FUEL collection uses the approximately 72-inch-deep staging band around the CENTER LINE, not the full 283-inch NEUTRAL ZONE depth.",
    "The AndyMark perimeter and wall tag poses use WPILib v2026.2.1. Interior features retain their welded center-relative geometry without scaling.",
    "Positive Y is scoring-table side and negative Y is non-scoring-table side.",
    "The ROBOT STARTING LINE is the alliance-side face of the HUB/BUMP/TRENCH band, not the center of those structures.",
    "AprilTags and HUB faces are perception/aiming references, not collision-free chassis poses.",
    "DEPOT barrier dimensions are official, but its exact floor polygon is not certified in this pack; never invent a center or route through a DEPOT reference.",
  ],
  landmarks: centeredLandmarks,
  solidObstacles: centeredLandmarks.filter((landmark) => landmark.behavior === "solid"),
  crossingBarriers,
  sources: [
    {
      label: "WPILib 2026 REBUILT AndyMark dimensions and wall tag poses",
      url: "https://github.com/wpilibsuite/allwpilib/blob/v2026.2.1/apriltag/src/main/native/resources/edu/wpi/first/apriltag/2026-rebuilt-andymark.json",
      revision: "v2026.2.1",
      sha256: "9b44d503e056e8303b6cee7ec65b0cf770cbea2e475516c03b95f8fcfdee49ca",
    },
    {
      label: "Original Bordeaux field overlay and calibrated playing rectangle",
      url: "https://github.com/zwatx/bordeaux/blob/8a0fdfc/src/renderer/assets/field.png",
      revision: "blue-origin-calibration-1",
      sha256: "4907a5b4a3045b27060f875f33b9793c4017a059961a1a9dbee7cc3421867ee7",
    },
    {
      label: "2026 FIRST Field Dimension Drawings",
      url: "https://firstfrc.blob.core.windows.net/frc2026/FieldAssets/2026-field-dimension-dwgs.pdf",
      revision: "2026-02-27",
      sha256: "3e2c1a0c35424a66821186584dda4f6709221ac8eb88036e09091452b8235f82",
    },
    {
      label: "2026 FIRST Robotics Competition Game Manual",
      url: "https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm",
      revision: "Team Update 19",
    },
    {
      label: "WPILib 2026 REBUILT welded field fixture",
      url: "https://github.com/wpilibsuite/allwpilib/tree/c610ffd17fb144e7348af48caad7f3944a7765b6",
      revision: "c610ffd17fb144e7348af48caad7f3944a7765b6",
      sha256: "d638062440a5970cdaeb3702d2113fecb6bfb5b0d2a095bd75d21aab0d8ee6b9",
    },
  ],
};

export const REBUILT_2026_CROSSINGS = {
  blue: {
    trenchTable: centeredLandmarks.find((item) => item.id === "blue-trench-table")!.point!,
    trenchAway: centeredLandmarks.find((item) => item.id === "blue-trench-away")!.point!,
    bumpTable: centeredLandmarks.find((item) => item.id === "blue-bump-table")!.point!,
    bumpAway: centeredLandmarks.find((item) => item.id === "blue-bump-away")!.point!,
  },
  red: {
    trenchTable: centeredLandmarks.find((item) => item.id === "red-trench-table")!.point!,
    trenchAway: centeredLandmarks.find((item) => item.id === "red-trench-away")!.point!,
    bumpTable: centeredLandmarks.find((item) => item.id === "red-bump-table")!.point!,
    bumpAway: centeredLandmarks.find((item) => item.id === "red-bump-away")!.point!,
  },
} as const;

export const REBUILT_2026_OFFICIAL_CROSSINGS = REBUILT_2026_CROSSINGS;
