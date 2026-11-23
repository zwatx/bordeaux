function uniqueId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === "function") return uuid.call(globalThis.crypto);
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

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
  return `routine_node_${globalThis.crypto.randomUUID()}`;
}

export function createPathLinkId(): string {
  return `pathlink_${uniqueId()}`;
}
