import { randomUuid } from "./randomUuid";
import type { RobotCamera, RobotConfig } from "./types";

/** Most cameras one robot holds. Adding past it leaves the robot as it is. */
export const CAMERA_LIMIT = 8;
/** Longest camera name the editor accepts. */
export const CAMERA_NAME_MAX = 40;

/**
 * Accepted range of each camera number. A field of view lies strictly between its bounds; the rest include them.
 * Validation and the Robot page's inputs both read these.
 */
export const CAMERA_RANGES = {
  fovDeg: { min: 0, max: 180 },
  /** Forward and left offsets from the robot center, meters. */
  offsetM: { min: -2, max: 2 },
  /** Lens height above the floor, meters. */
  heightM: { min: 0, max: 2.5 },
  yawDeg: { min: -180, max: 180 },
  pitchDeg: { min: -90, max: 90 },
} as const;

/*
 * A robot's cameras, kept on `RobotConfig.cameras` so each robot in a project has its own. A robot with none has no
 * list. Cameras describe what the robot can see and never change a plan. Every function returns a new robot, or the
 * same one when there is nothing to do.
 */

/** Adds a forward-facing camera at the front edge of the frame, named "Camera N" with the first free number. */
export function addCamera(robot: RobotConfig): RobotConfig {
  const cameras = robot.cameras ?? [];
  if (cameras.length >= CAMERA_LIMIT) return robot;
  const used = new Set(cameras.map((camera) => camera.name.toLowerCase()));
  let number = cameras.length + 1;
  while (used.has(`camera ${number}`)) number += 1;
  const camera: RobotCamera = {
    id: `camera_${randomUuid()}`,
    name: `Camera ${number}`,
    horizontalFovDeg: 70,
    verticalFovDeg: 50,
    positionM: { x: robot.l / 2, y: 0, z: 0.3 },
    yawDeg: 0,
    pitchDeg: 15,
  };
  return { ...robot, cameras: [...cameras, camera] };
}

/** Removes a camera. Removing the last one removes the list. */
export function removeCamera(robot: RobotConfig, id: string): RobotConfig {
  if (!robot.cameras?.some((camera) => camera.id === id)) return robot;
  const { cameras, ...rest } = robot;
  const kept = cameras!.filter((camera) => camera.id !== id);
  return kept.length ? { ...rest, cameras: kept } : rest;
}

/**
 * Changes one camera's details; its id stays. A name is trimmed and cut to `CAMERA_NAME_MAX`. An empty name, or one
 * another camera has, leaves the robot as it is.
 */
export function updateCamera(robot: RobotConfig, id: string, patch: Partial<Omit<RobotCamera, "id">>): RobotConfig {
  const cameras = robot.cameras;
  if (!cameras?.some((camera) => camera.id === id)) return robot;
  const change: Partial<RobotCamera> = { ...patch };
  if (change.name !== undefined) {
    const name = change.name.trim().slice(0, CAMERA_NAME_MAX).trimEnd();
    if (!name || cameras.some((camera) => camera.id !== id && camera.name.toLowerCase() === name.toLowerCase())) return robot;
    change.name = name;
  }
  return { ...robot, cameras: cameras.map((camera) => camera.id === id ? { ...camera, ...change, id } : camera) };
}
