import * as z from "zod/v4";
import { FIELD_H, FIELD_W } from "../math/fieldBounds";

const trimmedString = (maximum: number) => z.string().trim().min(1).max(maximum);

export const agentContextSchema = z.object({
  sessionId: trimmedString(200),
  revision: z.number().int().nonnegative(),
  activePathId: trimmedString(160),
});

export const robotPlanningProfileSchema = z.object({
  intake: z.object({
    name: trimmedString(80),
    centerM: z.object({ x: z.number().finite(), y: z.number().finite() }).describe("Robot-local meters: +X forward, +Y left."),
    directionDeg: z.number().finite().min(-180).max(180).describe("Outward collection direction counterclockwise from robot +X; front is 0 degrees."),
    captureWidthM: z.number().positive().max(3),
    maxCollectSpeedMps: z.number().positive().max(12),
  }).optional(),
  shooter: z.object({
    directionDeg: z.number().finite().min(-180).max(180).describe("Firing direction counterclockwise from robot +X; front is 0 degrees."),
    requiresTargetFacing: z.boolean(),
    preferredRangeM: z.number().positive().max(20).optional(),
  }).optional(),
  notes: z.string().trim().max(4_000).optional(),
});

export const routeLocationSchema = z.union([
  z.object({
    x: z.number().finite().min(0).max(FIELD_W),
    y: z.number().finite().min(0).max(FIELD_H),
    headingDeg: z.number().finite().optional(),
  }),
  z.object({ term: trimmedString(160) }),
]);

export const legTraversalSchema = z.enum(["direct", "trench-table", "trench-away", "bump-table", "bump-away"]);

export const fuelCollectionIntentSchema = z.object({
  maxHeadingErrorDeg: z.number().min(1).max(90).optional().describe("Maximum intake-to-travel heading error; defaults to 5 degrees."),
  allowCrosswiseHeading: z.boolean().optional().describe("Only true when the user explicitly wants a non-aligned collection strategy."),
});

export const routeStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("travel"), to: routeLocationSchema, traversal: legTraversalSchema.optional(), collectFuel: fuelCollectionIntentSchema.optional() }),
  z.object({
    kind: z.literal("swoosh"),
    at: routeLocationSchema.describe("Far longitudinal extent of the 180-degree maneuver, not its entry or center."),
    traversal: legTraversalSchema.optional().describe("Exact portal used on the approach leg when it reaches an alliance barrier."),
    turn: z.enum(["clockwise", "counterclockwise"]).describe("Turn direction as viewed in canonical Bordeaux overhead coordinates (+X right, +Y up)."),
    radiusM: z.number().min(0.25).max(2.5).describe("Radius of the 180-degree reversal in meters."),
    insetM: z.number().min(0).max(2).optional().describe("Distance to move the far extent back along the approach from a named zone boundary."),
    collectFuel: fuelCollectionIntentSchema.optional(),
  }),
]);

const endActionShape = {
  endAction: z.object({
    commandId: trimmedString(256),
    semanticTag: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    arguments: z.record(z.string(), z.json()).optional(),
    cancelOnPathEnd: z.boolean().optional(),
  }).optional(),
  endActionIntent: z.object({
    semanticTag: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
    description: trimmedString(200),
  }).optional(),
};

const commonPlanShape = {
  context: agentContextSchema.optional().describe("Snapshot handle returned by inspect_session. Supplying it makes retries reject stale editor state before planning."),
  intent: trimmedString(2_000),
  name: trimmedString(120).optional(),
  alliance: z.enum(["blue", "red"]),
  start: routeLocationSchema.optional(),
  minimumClearanceM: z.number().min(0).max(2).optional().describe("Advisory clearance target used for warnings and near-tie ranking; modeled intersections remain invalid."),
  maximumCandidates: z.number().int().min(1).max(5).optional(),
  nearTieWindowS: z.number().min(0).max(2).optional(),
  basePathId: trimmedString(160).optional(),
  robotHeightM: z.number().positive().max(5).optional().describe("Fallback height only for migrated projects whose robot configuration has no height; configured project height is authoritative."),
  finishFacing: z.object({
    mechanism: z.literal("shooter"),
    target: routeLocationSchema,
    maxHeadingErrorDeg: z.number().min(1).max(45).optional(),
  }).optional().describe("Mechanism-aware physical heading at the final pose. Use a separate non-collecting final travel step."),
  ...endActionShape,
};

const legacyPlanSchema = z.object({
  ...commonPlanShape,
  goals: z.array(routeLocationSchema).min(1).max(12),
  steps: z.never().optional(),
  traversal: z.enum(["fastest", "trench", "bump", "compare"]).optional(),
  collectFuel: fuelCollectionIntentSchema.optional().describe("Legacy-goals shorthand only."),
});

const orderedPlanSchema = z.object({
  ...commonPlanShape,
  steps: z.array(routeStepSchema).min(1).max(12),
  goals: z.never().optional(),
  traversal: z.never().optional(),
  collectFuel: z.never().optional(),
});

export const planPathRequestSchema = z.union([legacyPlanSchema, orderedPlanSchema])
  .refine((value) => !(value.endAction && value.endActionIntent), { message: "Provide endAction or endActionIntent, not both." });

export const inspectSessionInputSchema = z.object({});
export const inspectRobotProfileInputSchema = z.object({});
export const proposeRobotProfileInputSchema = z.object({
  context: agentContextSchema.optional(),
  intent: trimmedString(1_000),
  planning: robotPlanningProfileSchema,
});
export const resolveFieldTermsInputSchema = z.object({
  phrases: z.array(trimmedString(160)).min(1).max(24).refine((values) => new Set(values).size === values.length, { message: "Field phrases must be unique." }),
  alliance: z.enum(["blue", "red"]).optional(),
  pose: z.discriminatedUnion("headingSource", [
    z.object({ headingSource: z.literal("physical"), x: z.number().min(0).max(FIELD_W), y: z.number().min(0).max(FIELD_H), physicalHeadingRad: z.number().finite() }),
    z.object({ headingSource: z.literal("authored"), x: z.number().min(0).max(FIELD_W), y: z.number().min(0).max(FIELD_H), authoredHeadingRad: z.number().finite(), driveBackward: z.boolean() }),
  ]).optional(),
  relativeDistanceM: z.number().min(0.01).max(5).optional(),
  robotHeightM: z.number().positive().max(5).optional().describe("Fallback height only for migrated projects whose robot configuration has no height; configured project height is authoritative."),
});
export const analyzePathInputSchema = z.object({
  context: agentContextSchema.optional(),
  pathId: trimmedString(160).optional(),
  detail: z.enum(["summary", "samples"]).default("summary"),
  sampleLimit: z.number().int().min(50).max(2_000).optional(),
  minimumClearanceM: z.number().min(0).max(2).optional(),
});
export const repairPathInputSchema = z.object({
  context: agentContextSchema.optional(),
  pathId: trimmedString(160).optional(),
  findingIds: z.array(trimmedString(200)).min(1).max(8).refine((values) => new Set(values).size === values.length, { message: "Finding IDs must be unique." }),
  minimumClearanceM: z.number().min(0).max(2).optional(),
});
export const getProposalInputSchema = z.object({
  proposalId: trimmedString(200),
  detail: z.enum(["summary", "full"]).default("summary"),
});
