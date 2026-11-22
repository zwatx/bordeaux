import type { AllianceColor } from "../agent/types";

export interface FieldPoint {
  x: number;
  y: number;
}

export interface FieldRect {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface FieldLandmark {
  id: string;
  name: string;
  aliases: string[];
  kind: "point" | "region" | "line" | "portal" | "obstacle";
  behavior?: "solid" | "traversable" | "overhead" | "climbable" | "interaction" | "line";
  allianceOwner?: AllianceColor;
  point?: FieldPoint;
  bounds?: FieldRect;
  line?: { start: FieldPoint; end: FieldPoint };
  traversal?: "trench" | "bump";
  allianceSide?: "left" | "right";
  openingWidthM?: number;
  clearanceHeightM?: number;
  /** False for official vocabulary that is not a legal on-field drive target. */
  navigable?: boolean;
  description?: string;
  elevationM?: number;
  headingDeg?: number;
  attachedTo?: string;
  dimensionsM?: { length?: number; width?: number; depth?: number; height?: number; diameter?: number };
}

export interface FieldTraversalPortal {
  id: string;
  name: string;
  allianceOwner: AllianceColor;
  traversal: "trench" | "bump";
  side: "table" | "away";
  allianceSide: "left" | "right";
  point: FieldPoint;
  widthM: number;
  /** Full official-frame traversable footprint of the structure/opening. */
  bounds: FieldRect;
  /** Longitudinal structure depth along field X. */
  depthM: number;
  clearanceHeightM?: number;
}

export interface FieldCrossingBarrier {
  id: string;
  allianceOwner: AllianceColor;
  x: number;
  portals: FieldTraversalPortal[];
}

export interface FieldPack {
  id: "2026-rebuilt";
  revision: string;
  name: string;
  dimensions: { lengthM: number; widthM: number };
  imageCalibration: { width: number; height: number; left: number; right: number; top: number; bottom: number; rotationDeg: number };
  coordinateFrame: string;
  appDisplayTransform: {
    appLengthM: number;
    appWidthM: number;
    description: string;
  };
  authoringInvariants: string[];
  landmarks: FieldLandmark[];
  solidObstacles: FieldLandmark[];
  crossingBarriers: FieldCrossingBarrier[];
  sources: Array<{ label: string; url: string; revision: string; sha256?: string }>;
}

export interface PhysicalRobotPose extends FieldPoint {
  headingSource: "physical";
  physicalHeadingRad: number;
}

export interface AuthoredRobotPose extends FieldPoint {
  headingSource: "authored";
  authoredHeadingRad: number;
  driveBackward: boolean;
}

export type RobotRelativePose = PhysicalRobotPose | AuthoredRobotPose;

export interface ResolvedFieldTerm {
  phrase: string;
  status: "resolved" | "ambiguous" | "unresolved";
  matches: Array<{
    id: string;
    label: string;
    point: FieldPoint;
    /** Renderer position after the current Blue/Red view transform. */
    displayPoint?: FieldPoint;
    officialPoint?: FieldPoint;
    confidence: number;
    reason: string;
    navigable?: boolean;
    traversal?: "trench" | "bump";
    headingDeg?: number;
  }>;
  message?: string;
  warnings?: string[];
}

export interface ResolveFieldTermOptions {
  alliance?: AllianceColor;
  /** Fallback context for uncolored terms; never conflicts with an explicit color in the phrase. */
  defaultAlliance?: AllianceColor;
  /** Current renderer view. This affects only reported display positions, never field ownership. */
  allianceView?: AllianceColor;
  pose?: RobotRelativePose;
  relativeDistanceM?: number;
  robotHeightM?: number;
}
