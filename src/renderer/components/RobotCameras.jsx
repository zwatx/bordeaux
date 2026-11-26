import * as React from 'react';
import { UI } from './ui';
import { NameInput } from './RobotCards';
import { CAMERA_LIMIT, CAMERA_NAME_MAX, CAMERA_RANGES, addCamera, removeCamera, updateCamera } from '../../core/robotCameras';
import { CAMERA_SCENE_VIEWS, cameraScene } from '../lib/cameraScene';

const h = React.createElement;
const STAGE = { width: 640, height: 320 };
const VIEW_OPTIONS = [{ v: 'iso', label: '3D' }, { v: 'top', label: 'Top' }, { v: 'side', label: 'Side' }, { v: 'front', label: 'Front' }];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const ZOOM = { min: 0.5, max: 4, step: 1.25 };

// One box per number. A field of view is strictly inside its range, so its box stops one degree short of each end.
const position = (axis) => ({ read: (camera) => camera.positionM[axis], patch: (camera, value) => ({ positionM: { ...camera.positionM, [axis]: value } }) });
const direct = (key) => ({ read: (camera) => camera[key], patch: (_camera, value) => ({ [key]: value }) });
const FOV = { unit: '°', min: CAMERA_RANGES.fovDeg.min + 1, max: CAMERA_RANGES.fovDeg.max - 1, precision: 1, step: 1 };
const FIELDS = [
  { short: 'Horizontal', label: 'Camera horizontal field of view', ...direct('horizontalFovDeg'), ...FOV },
  { short: 'Vertical', label: 'Camera vertical field of view', ...direct('verticalFovDeg'), ...FOV },
  { short: 'Forward', label: 'Camera forward of center', hint: 'From the robot center. Negative is behind it.', ...position('x'), unit: 'm', ...CAMERA_RANGES.offsetM },
  { short: 'Left', label: 'Camera left of center', hint: 'From the robot center. Negative is to the right.', ...position('y'), unit: 'm', ...CAMERA_RANGES.offsetM },
  { short: 'Height', label: 'Camera height above floor', ...position('z'), unit: 'm', ...CAMERA_RANGES.heightM },
  { short: 'Yaw', label: 'Camera yaw', hint: '0° faces the robot front. Positive turns left.', ...direct('yawDeg'), unit: '°', ...CAMERA_RANGES.yawDeg, precision: 1, step: 1 },
  { short: 'Pitch', label: 'Camera pitch', hint: '0° is level. Positive looks up.', ...direct('pitchDeg'), unit: '°', ...CAMERA_RANGES.pitchDeg, precision: 1, step: 1 },
];

const sceneItem = (item, index) => item.kind === 'face' ? h('polygon', { key: index, className: 'rp-cam-' + item.tone + (item.selected ? ' on' : ''), points: item.points })
  : item.kind === 'drop' ? h('line', { key: index, className: 'rp-cam-drop', x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2 })
  : item.kind === 'lens' ? h('circle', { key: index, className: 'rp-cam-lens' + (item.selected ? ' on' : ''), cx: item.x, cy: item.y, r: item.selected ? 5 : 4 })
  : h('text', { key: index, className: 'rp-cam-name' + (item.selected ? ' on' : ''), x: item.x, y: item.y, textAnchor: 'middle' }, item.text);

/**
 * The Robot page's Cameras section for the selected robot. A 3D view draws the bumper outline at the robot's height and every camera's view
 * volume from its numbers: drag it or use the arrow keys to turn it, or pick a named view. Pinch, Ctrl or Command with
 * the wheel, the + and - keys and the two buttons zoom it; a plain wheel still scrolls the page. The buttons in its
 * top corner pick a camera or add one, and the boxes below edit the picked camera. `footprint` is the bumper outline in
 * robot-local meters; `BigNum` is the Robot page's number box.
 */
export function RobotCameras({ robot, setRobot, footprint, BigNum }) {
  const cameras = robot.cameras ?? [];
  const [pickedId, setPickedId] = React.useState(null);
  const [view, setView] = React.useState(CAMERA_SCENE_VIEWS.iso);
  const [renaming, setRenaming] = React.useState(false);
  const [zoom, setZoom] = React.useState(1);
  const drag = React.useRef(null), stage = React.useRef(null);
  const zoomBy = (factor) => setZoom((current) => clamp(current * factor, ZOOM.min, ZOOM.max));
  // React's wheel listener is passive, and a pinch must not also zoom the whole page.
  React.useEffect(() => {
    const svg = stage.current;
    if (!svg) return undefined;
    const wheel = (event) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); zoomBy(Math.exp(-event.deltaY * 0.01)); };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, [cameras.length > 0]);
  // Another robot's cameras have other ids, so the first camera is shown until one is picked.
  const selected = cameras.find((camera) => camera.id === pickedId) ?? cameras[0] ?? null;
  const scene = React.useMemo(() => cameraScene({ footprint, heightM: robot.heightM, cameras, selectedId: selected?.id ?? null, view, zoom, ...STAGE }),
    [footprint, robot.heightM, robot.cameras, selected?.id, view, zoom]);
  const namedView = Object.keys(CAMERA_SCENE_VIEWS).find((key) => CAMERA_SCENE_VIEWS[key].azDeg === view.azDeg && CAMERA_SCENE_VIEWS[key].elDeg === view.elDeg);
  const turn = (azDeg, elDeg) => setView((current) => ({ azDeg: current.azDeg + azDeg, elDeg: clamp(current.elDeg + elDeg, 2, 89.9) }));
  const pick = (id) => { setPickedId(id); setRenaming(false); };
  const add = () => {
    const next = addCamera(robot);
    if (next === robot) return;
    setRobot({ cameras: next.cameras });
    pick(next.cameras[next.cameras.length - 1].id);
  };
  const remove = () => {
    const index = cameras.indexOf(selected);
    setRobot({ cameras: removeCamera(robot, selected.id).cameras });
    pick((cameras[index + 1] ?? cameras[index - 1])?.id ?? null);
  };

  if (!selected) return h('div', { className: 'settings-card' },
    h('div', { className: 'settings-row' },
      h('div', { className: 'settings-label' }, h('strong', null, 'No cameras')),
      h('div', { className: 'settings-control' }, h('button', { className: 'qbtn', type: 'button', onClick: add }, 'Add camera'))));

  return h('div', { className: 'settings-card rp-cameras' },
    h('div', { className: 'rp-cam-stage' },
      h('svg', { ref: stage, viewBox: `0 0 ${STAGE.width} ${STAGE.height}`, tabIndex: 0, role: 'img',
        'aria-label': 'Robot and camera views in 3D. Drag or use the arrow keys to turn the view. Plus and minus zoom.',
        onPointerDown: (event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY }; },
        onPointerMove: (event) => {
          if (!drag.current) return;
          turn((drag.current.x - event.clientX) * 0.5, (event.clientY - drag.current.y) * 0.4);
          drag.current = { x: event.clientX, y: event.clientY };
        },
        onPointerUp: () => { drag.current = null; }, onPointerCancel: () => { drag.current = null; },
        onKeyDown: (event) => {
          const az = event.key === 'ArrowLeft' ? 10 : event.key === 'ArrowRight' ? -10 : 0, el = event.key === 'ArrowUp' ? 5 : event.key === 'ArrowDown' ? -5 : 0;
          const scale = event.key === '+' || event.key === '=' ? ZOOM.step : event.key === '-' ? 1 / ZOOM.step : 0;
          if (!az && !el && !scale) return;
          event.preventDefault();
          if (scale) zoomBy(scale); else turn(az, el);
        } },
        scene.grid.map((line, index) => h('line', { key: index, className: 'rp-cam-grid', ...line })),
        scene.items.map(sceneItem)),
      h('div', { className: 'rp-cam-picks', role: 'group', 'aria-label': 'Cameras' },
        cameras.map((camera) => h('button', { key: camera.id, type: 'button', className: 'rp-cam-pick' + (camera === selected ? ' on' : ''), 'aria-pressed': camera === selected, onClick: () => pick(camera.id) }, camera.name)),
        cameras.length < CAMERA_LIMIT && h('button', { type: 'button', className: 'rp-cam-pick new', onClick: add }, '+ New camera')),
      h(UI.Seg, { className: 'rp-cam-views', ariaLabel: '3D view angle', value: namedView, options: VIEW_OPTIONS, onChange: (key) => setView(CAMERA_SCENE_VIEWS[key]) }),
      h('span', { className: 'rp-cam-tip', 'aria-hidden': true }, 'Drag to turn'),
      h('div', { className: 'rp-cam-zoom', role: 'group', 'aria-label': 'Zoom' },
        h('button', { type: 'button', className: 'rp-cam-action', 'aria-label': 'Zoom out', title: 'Zoom out', disabled: zoom <= ZOOM.min, onClick: () => zoomBy(1 / ZOOM.step) }, h(UI.Icon, { name: 'minus', size: 14 })),
        h('button', { type: 'button', className: 'rp-cam-action', 'aria-label': 'Zoom in', title: 'Zoom in', disabled: zoom >= ZOOM.max, onClick: () => zoomBy(ZOOM.step) }, h(UI.Icon, { name: 'plus', size: 14 })))),
    h('div', { className: 'rp-cam-detail' },
      h('div', { className: 'rp-cam-head' },
        renaming
          ? h(NameInput, { robot: selected, label: 'Camera name', maxLength: CAMERA_NAME_MAX, takenMessage: 'Another camera has this name.',
              taken: (name) => cameras.some((camera) => camera !== selected && camera.name.toLowerCase() === name.toLowerCase()),
              onDone: (name) => { setRenaming(false); if (name) setRobot({ cameras: updateCamera(robot, selected.id, { name }).cameras }); } })
          : h('strong', null, selected.name),
        !renaming && h('span', { className: 'rp-cam-actions' },
          h('button', { type: 'button', className: 'rp-cam-action', 'aria-label': 'Rename ' + selected.name, title: 'Rename ' + selected.name, onClick: () => setRenaming(true) }, h(UI.Icon, { name: 'edit', size: 14 })),
          h('button', { type: 'button', className: 'rp-cam-action', 'aria-label': 'Delete ' + selected.name, title: 'Delete ' + selected.name, onClick: remove }, h(UI.Icon, { name: 'trash', size: 14 })))),
      h('div', { className: 'rp-cam-fields' },
        FIELDS.map(({ short, label, hint, read, patch, ...box }) => h('label', { key: short + selected.id, title: hint },
          short,
          h(BigNum, { ...box, label, value: read(selected), onChange: (value) => setRobot({ cameras: updateCamera(robot, selected.id, patch(selected, value)).cameras }) }))))));
}
