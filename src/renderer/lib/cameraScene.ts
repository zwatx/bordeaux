import { cameraAxes } from "../../core/robotCameras";
import type { ControlPoint, RobotCamera } from "../../core/types";

/** Where the viewer stands: `azDeg` around the robot from its front (counterclockwise from above), `elDeg` above the floor. */
export interface CameraSceneView { azDeg: number; elDeg: number }

/** The Robot page's named views. Top and Side put the robot front on the right, like the footprint preview. */
export const CAMERA_SCENE_VIEWS = {
  iso: { azDeg: -60, elDeg: 30 },
  top: { azDeg: -90, elDeg: 89.9 },
  side: { azDeg: -90, elDeg: 3 },
  front: { azDeg: 0, elDeg: 3 },
} as const satisfies Record<string, CameraSceneView>;

interface Segment { x1: number; y1: number; x2: number; y2: number }
export type CameraSceneItem =
  | { kind: "face"; points: string; tone: "body" | "bodyTop" | "arrow" | "view" | "viewEnd"; selected: boolean }
  | ({ kind: "drop" } & Segment)
  | { kind: "lens"; x: number; y: number; selected: boolean }
  | { kind: "label"; x: number; y: number; text: string; selected: boolean };

type Vec = readonly [number, number, number];

/** Height the bumper outline is drawn to, meters. */
const BODY_HEIGHT_M = 0.22;
/** How far each view volume is drawn from its lens, meters. It shows direction and angle, not how far the camera reads. */
const VIEW_DEPTH_M = 0.8;
/** Viewer distance for the perspective, meters. */
const EYE_M = 7;
const GRID_M = 0.5, GRID_LINES = 4;
/** Widest angle drawn. A wider field of view is still stored; its drawn volume stops here so it stays finite. */
const DRAWN_FOV_MAX_DEG = 170;

/**
 * The Robot page's 3D drawing of a robot and its cameras, as flat SVG shapes: a floor grid in half meters, the bumper
 * outline raised into a block with an arrow on its front, and each camera's view volume from its lens, with a dashed
 * line down to the floor. `items` are ordered far to near, so drawing them in order hides what is behind. Shapes that
 * pass through each other can still draw in the wrong order from some angles.
 */
export function cameraScene({ footprint, cameras, selectedId, view, width, height }: {
  /** Bumper outline in robot-local meters. */
  footprint: readonly ControlPoint[];
  cameras: readonly RobotCamera[];
  selectedId: string | null;
  view: CameraSceneView;
  width: number;
  height: number;
}): { grid: Segment[]; items: CameraSceneItem[] } {
  const az = view.azDeg * Math.PI / 180, el = view.elDeg * Math.PI / 180;
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
  const target: Vec = [0, 0, 0.3];

  const volumes = cameras.map((camera) => {
    const { forward, left, up } = cameraAxes(camera);
    const lens: Vec = [camera.positionM.x, camera.positionM.y, camera.positionM.z];
    const half = (deg: number) => Math.tan(Math.min(deg, DRAWN_FOV_MAX_DEG) / 2 * Math.PI / 180) * VIEW_DEPTH_M;
    const across = half(camera.horizontalFovDeg), along = half(camera.verticalFovDeg);
    const at = (a: number, b: number): Vec => [
      lens[0] + forward.x * VIEW_DEPTH_M + left.x * a + up.x * b,
      lens[1] + forward.y * VIEW_DEPTH_M + left.y * a + up.y * b,
      lens[2] + forward.z * VIEW_DEPTH_M + left.z * a + up.z * b,
    ];
    return { camera, lens, corners: [at(across, along), at(-across, along), at(-across, -along), at(across, -along)], label: at(0, along + 0.1) };
  });

  // One scale for every viewing angle: the farthest drawn point from the target just fits the shorter side.
  const reach = Math.max(0.6, ...[...footprint.map((point): Vec => [point.x, point.y, 0]), ...volumes.flatMap((volume) => [volume.lens, ...volume.corners])]
    .map((point) => Math.hypot(point[0] - target[0], point[1] - target[1], point[2] - target[2])));
  const scale = Math.min(width, height) / 2 / reach * 1.25;
  /** Screen x and y, and distance toward the viewer. */
  const project = (point: Vec): Vec => {
    const x = point[0] - target[0], y = point[1] - target[1], z = point[2] - target[2];
    const depth = x * ce * ca + y * ce * sa + z * se;
    const k = EYE_M / (EYE_M - depth) * scale;
    return [width / 2 + (-x * sa + y * ca) * k, height * 0.6 - (-x * se * ca - y * se * sa + z * ce) * k, depth];
  };
  const round = (value: number) => Math.round(value * 10) / 10;
  const segment = (a: Vec, b: Vec): Segment => { const p = project(a), q = project(b); return { x1: round(p[0]), y1: round(p[1]), x2: round(q[0]), y2: round(q[1]) }; };

  const grid: Segment[] = [];
  const edge = GRID_M * GRID_LINES;
  for (let index = -GRID_LINES; index <= GRID_LINES; index += 1) {
    grid.push(segment([index * GRID_M, -edge, 0], [index * GRID_M, edge, 0]), segment([-edge, index * GRID_M, 0], [edge, index * GRID_M, 0]));
  }

  const drawn: Array<{ depth: number; item: CameraSceneItem }> = [];
  const face = (corners: readonly Vec[], tone: Extract<CameraSceneItem, { kind: "face" }>["tone"], selected = false, bias = 0) => {
    const projected = corners.map(project);
    drawn.push({ depth: projected.reduce((sum, point) => sum + point[2], 0) / projected.length + bias,
      item: { kind: "face", tone, selected, points: projected.map((point) => `${round(point[0])},${round(point[1])}`).join(" ") } });
  };

  const floor = footprint.map((point): Vec => [point.x, point.y, 0]), roof = footprint.map((point): Vec => [point.x, point.y, BODY_HEIGHT_M]);
  face(roof, "bodyTop");
  floor.forEach((point, index) => { const next = (index + 1) % floor.length; face([point, floor[next], roof[next], roof[index]], "body"); });
  const front = Math.max(0.1, ...footprint.map((point) => point.x));
  face(([[0, -0.04], [0.5, -0.04], [0.5, -0.17], [0.85, 0], [0.5, 0.17], [0.5, 0.04], [0, 0.04]] as const)
    .map(([x, y]): Vec => [x * front, y * front, BODY_HEIGHT_M]), "arrow", false, 0.02);

  let labels: CameraSceneItem[] = [];
  for (const { camera, lens, corners, label } of volumes) {
    const selected = camera.id === selectedId;
    corners.forEach((corner, index) => face([lens, corner, corners[(index + 1) % 4]], "view", selected));
    face(corners, "viewEnd", selected);
    const at = project(lens), text = project(label);
    drawn.push({ depth: at[2] - 0.01, item: { kind: "drop", ...segment(lens, [lens[0], lens[1], 0]) } });
    drawn.push({ depth: at[2] + 0.03, item: { kind: "lens", x: round(at[0]), y: round(at[1]), selected } });
    labels.push({ kind: "label", x: round(text[0]), y: round(text[1]), text: camera.name, selected });
  }
  // The selected camera's name is drawn last, over the others.
  labels = [...labels.filter((item) => item.kind === "label" && !item.selected), ...labels.filter((item) => item.kind === "label" && item.selected)];
  return { grid, items: [...drawn.sort((a, b) => a.depth - b.depth).map((entry) => entry.item), ...labels] };
}
