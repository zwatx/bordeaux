import type { CommandInvocation, CommandLoopUntil, Marker } from "./types";

/** A path event's command group holds 2–16 commands. */
export const MIN_GROUP_COMMANDS = 2;
export const MAX_GROUP_COMMANDS = 16;
/** Time loop limits, in seconds. */
export const MIN_LOOP_SECONDS = 0.02;
export const MAX_LOOP_SECONDS = 3600;

/**
 * The commands a path event starts: its group's commands in order, or its single invocation.
 * Tolerates unvalidated project data so main-process scans can use it before validation.
 */
export function markerInvocations(marker: Pick<Marker, "invocation" | "commandGroup"> | null | undefined): CommandInvocation[] {
  if (!marker) return [];
  const commands = marker.commandGroup?.commands;
  if (Array.isArray(commands)) return commands.filter((command) => !!command && typeof command === "object");
  return marker.invocation ? [marker.invocation] : [];
}

/**
 * An invocation as exports carry it to the robot: per-use power estimates are planning-only and stay in the project.
 * They may still change planned samples through the path's command reserve.
 */
export function exportedInvocation(invocation: CommandInvocation): CommandInvocation {
  if (!invocation || typeof invocation !== "object" || !("power" in invocation)) return invocation;
  const { power: _power, ...rest } = invocation;
  return rest;
}

/** True when an event needs the BDX 1.2 event extension (a loop or a group). */
export function markerUsesEventExtension(marker: Pick<Marker, "invocation" | "commandGroup">): boolean {
  return !!marker.commandGroup || markerInvocations(marker).some((invocation) => !!invocation.loop);
}

export type PathLoopUntil = Exclude<CommandLoopUntil, { kind: "output" }>;
