import * as React from 'react';
import fieldImage from '../assets/field.png';
import { ACTIVE_FIELD_REFERENCE } from '../../core/field/rebuilt2026';
import { FIELD_IMAGE, FIELD_IMAGE_SCALE, worldToFieldImage } from '../../core/field/imageCalibration';
import { UnitPrefs } from '../lib/unitPreferences';

const h = React.createElement;
const { width, height, left, right, top, bottom, rotationDeg } = FIELD_IMAGE;
const fieldWidth = right - left, fieldHeight = bottom - top;
const wholeField = [left, top, fieldWidth, fieldHeight];
const sides = ['local', 'robot'];
const project = ([x, y]) => worldToFieldImage({ x, y });

// Refuse unsupported coordinates and numeric ranges that cannot be rendered at a useful field scale.
function canPlot(route) {
  return route?.field.coordinateSchemaId === ACTIVE_FIELD_REFERENCE.coordinateSchemaId
    && route.points.every(point => point.every(value => Math.abs(value) < 1000))
    && route.width < 1000 && route.length < 1000;
}

function fitPaths(routes, art) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const route of routes) {
    const radius = Math.hypot(route.width, route.length) / 2;
    for (const [x, y] of route.points) {
      x0 = Math.min(x0, x - radius); x1 = Math.max(x1, x + radius);
      y0 = Math.min(y0, y - radius); y1 = Math.max(y1, y + radius);
    }
  }
  const a = project([x0, y1]), b = project([x1, y0]), ratio = fieldWidth / fieldHeight;
  const w = Math.max(b.x - a.x + 1.2 * FIELD_IMAGE_SCALE.x, (b.y - a.y + 1.2 * FIELD_IMAGE_SCALE.y) * ratio, 4 * FIELD_IMAGE_SCALE.x);
  if (art && w >= fieldWidth && a.x >= left && b.x <= right && a.y >= top && b.y <= bottom) return wholeField;
  const center = (start, end, span, min, max) => {
    const middle = (start + end - span) / 2;
    return art && start >= min && end <= max && span <= max - min ? Math.max(min, Math.min(max - span, middle)) : middle;
  };
  return [center(a.x, b.x, w, left, right), center(a.y, b.y, w / ratio, top, bottom), w, w / ratio];
}

// The robot's arrows sit between the computer's so overlapping routes keep separate, readable direction marks.
const arrowAt = { local: [0.2, 0.45, 0.7], robot: [0.32, 0.57, 0.82] };

function arrows(points, size, fractions) {
  const distance = [0];
  for (let i = 1; i < points.length; i++) {
    distance.push(distance[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return fractions.flatMap(fraction => {
    const at = distance.at(-1) * fraction;
    const next = distance.findIndex(value => value > at);
    if (next < 1) return [];
    const a = points[next - 1], b = points[next];
    const dx = b.x - a.x, dy = b.y - a.y;
    const along = (at - distance[next - 1]) / (distance[next] - distance[next - 1]);
    const rotate = Math.atan2(dy, dx) * 180 / Math.PI;
    return [h('path', { key: fraction, d: `M${-size} ${-size * .65} L0 0 L${-size} ${size * .65}`,
      transform: `translate(${a.x + dx * along} ${a.y + dy * along}) rotate(${rotate})`, className: 'rfp-route-arrow' })];
  });
}

function Trace({ side, route, size, casing }) {
  const points = route.points.map(project), start = points[0], end = points.at(-1);
  const coords = points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  if (casing) return h('polyline', { className: 'rfp-route-casing', points: coords });
  const sw = size * (side === 'local' ? 0.85 : 0.6);
  return h('g', { 'data-route': side },
    h('polyline', { className: 'rfp-route-stroke', points: coords }),
    arrows(points, size, arrowAt[side]),
    h('circle', { className: 'rfp-route-start', cx: start.x, cy: start.y, r: sw }),
    h('rect', { className: 'rfp-route-end', width: route.length, height: route.width, x: -route.length / 2, y: -route.width / 2,
      transform: `translate(${end.x} ${end.y}) scale(${FIELD_IMAGE_SCALE.x} ${-FIELD_IMAGE_SCALE.y}) rotate(${(route.endHeading % (2 * Math.PI)) * 180 / Math.PI})` }));
}

function Grid({ box }) {
  // The grid sits in world metres. Limit lines for routes far outside the playing field.
  const [x, y, w, hgt] = box, stride = Math.max(1, Math.ceil(w / FIELD_IMAGE_SCALE.x / 32));
  const lines = (min, span, origin, scale, vertical) => {
    const start = Math.ceil((min - origin) / (scale * stride)), end = Math.floor((min + span - origin) / (scale * stride));
    return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => {
      const at = origin + (start + index) * scale * stride;
      return h('line', { key: (vertical ? 'x' : 'y') + index, x1: vertical ? at : x, x2: vertical ? at : x + w,
        y1: vertical ? y : at, y2: vertical ? y + hgt : at });
    });
  };
  return h('g', { className: 'rfp-field-grid' }, lines(x, w, left, FIELD_IMAGE_SCALE.x, true), lines(y, hgt, bottom, FIELD_IMAGE_SCALE.y, false));
}

function routeDescription(route, label) {
  const location = ([x, y]) => 'X ' + UnitPrefs.format(x, 'm', 2) + ', Y ' + UnitPrefs.format(y, 'm', 2);
  return label + ' starts at ' + location(route.points[0]) + ' and ends at ' + location(route.points.at(-1)) + '.';
}

export function RobotPathField({ routes, verdict, widestGap, gap }) {
  const [whole, setWhole] = React.useState(false);
  const [hidden, setHidden] = React.useState(null);
  const [single, setSingle] = React.useState('local');
  const available = sides.filter(side => canPlot(routes?.[side]));
  if (!routes) return null;
  if (!available.length) return h('p', { className: 'rfp-field-caution' }, 'These coordinates can’t be placed on the field.');
  const separate = available.length === 2 && routes.local.field.id !== routes.robot.field.id;
  const shown = separate ? [single] : available.filter(side => side !== hidden);
  const active = shown.map(side => routes[side]);
  const field = active[0].field;
  const art = field.id === ACTIVE_FIELD_REFERENCE.id;
  const differentRevision = art && active.some(route => route.field.revision !== ACTIVE_FIELD_REFERENCE.revision);
  const unavailable = sides.some(side => routes[side] && !available.includes(side));
  const caption = [unavailable && 'One route uses coordinates that can’t be placed on the field.',
    separate && 'The two files use different fields. Select a route to view it.',
    !art && 'Field ' + field.id + ' isn’t installed. Showing a coordinate grid.',
    differentRevision && 'A file uses a different field revision. Landmarks may differ.'].filter(Boolean).join(' ');
  const box = art && whole ? wholeField : fitPaths(separate ? active : available.map(side => routes[side]), art);
  const ends = widestGap && typeof gap === 'number' && shown.length === 2
    ? [project(widestGap.local), project(widestGap.robot)] : null;
  const gapLine = ends && { x1: ends[0].x, y1: ends[0].y, x2: ends[1].x, y2: ends[1].y };
  const labels = { local: 'This computer', robot: 'Robot' };
  const group = (label, children) => h('div', { role: 'group', 'aria-label': label }, children);
  const toggle = (label, pressed, onClick, props) => h('button', { type: 'button', className: 'qbtn', 'aria-pressed': pressed, onClick, ...props }, label);
  const view = (label, on, onClick) => h('button', { key: label, type: 'button', className: 'seg-i' + (on ? ' on' : ''), 'aria-pressed': on, onClick }, label);
  return h('figure', { className: 'rfp-field' },
    h('div', { className: 'rfp-field-tools' },
      art && h('div', { role: 'group', 'aria-label': 'Field view', className: 'seg', style: { '--seg-count': 2 } },
        view('Fit paths', !whole, () => setWhole(false)), view('Whole field', whole, () => setWhole(true))),
      group('Show routes', sides.map(side => {
        const enabled = available.includes(side), visible = shown.includes(side);
        const why = routes[side] && !enabled ? ' · unsupported frame'
          : !enabled && side === 'local' ? ' · unavailable'
          : !enabled ? verdict === 'missing' ? ' · missing' : ' · unavailable' : '';
        const select = () => {
          if (separate) setSingle(side);
          else if (!visible || shown.length > 1) setHidden(visible ? side : null);
        };
        return toggle(labels[side] + why, visible, select, { key: side, 'data-route': side, disabled: !enabled,
          'aria-disabled': !separate && visible && shown.length === 1 || undefined });
      }))),
    h('svg', { className: 'rfp-field-map', viewBox: box.join(' '), role: 'img', 'aria-label': [
      ...shown.map(side => routeDescription(routes[side], labels[side])),
      gapLine && 'The widest gap between the routes is about ' + UnitPrefs.format(gap, 'm', 3) + '.',
    ].filter(Boolean).join(' ') },
      art ? h(React.Fragment, null,
        h('image', { className: 'rfp-field-art', href: fieldImage, width, height, transform: `rotate(${rotationDeg} ${(left + right) / 2} ${(top + bottom) / 2})` }),
        h('rect', { className: 'rfp-field-border', x: left, y: top, width: fieldWidth, height: fieldHeight }))
        : h(Grid, { box }),
      shown.map(side => h(Trace, { key: side + '-casing', route: routes[side], casing: true })),
      shown.map(side => h(Trace, { key: side, side, route: routes[side], size: box[2] / 85 })),
      gapLine && h('g', { className: 'rfp-field-gap' },
        h('line', { className: 'rfp-gap-casing', ...gapLine }),
        h('line', { className: 'rfp-gap-line', ...gapLine }),
        ends.map(({ x, y }, i) => h('circle', { key: sides[i], 'data-route': sides[i], cx: x, cy: y, r: box[2] / 250 })))),
    caption && h('figcaption', { className: 'rfp-field-caution' }, caption));
}
