import { randomUuid } from "../randomUuid";

const uniqueId = (): string => randomUuid();

export function createPathId(): string {
  return `path_${uniqueId()}`;
}

export function createMarkerId(): string {
  return `event_${uniqueId()}`;
}

export function createRoutineId(): string {
  return `routine_${uniqueId()}`;
}

export function createRoutineNodeId(): string {
  return `routine_node_${randomUuid()}`;
}

export function createPathLinkId(): string {
  return `pathlink_${uniqueId()}`;
}
