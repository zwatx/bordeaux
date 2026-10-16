import { plainProblem } from './planProblems';

const overlapArea = (a, b) => Math.max(0, Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)) * Math.max(0, Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
const overlaps = (a,b) => overlapArea(a,b) > 0;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Badge limits never change the planner's indices, including a selection beyond the first twelve. */
export function problemBadgeIndexes(issues, selected, maximum = 12) {
  const indexes = [];
  for (let i = 0; i < issues.length && indexes.length < maximum; i++) if (issues[i].severity !== 'note') indexes.push(i);
  if (maximum > 0 && issues[selected] && issues[selected].severity !== 'note' && !indexes.includes(selected)) {
    if (indexes.length === maximum) indexes.pop();
    indexes.push(selected);
  }
  return indexes;
}

/** One placement result serves badges and the field's other label collision checks. Values are SVG units. */
export function placeProblemBadges(issues, indexes, pointAt, bounds, scale, obstacles = []) {
  const occupied = [...obstacles], r = 12 * scale;
  return indexes.map(index => {
    const issue = issues[index], anchor = pointAt((issue.f0 + issue.f1) / 2);
    let box;
    // Flip below first, then try nearby slots. Even co-located problems keep separate hit targets.
    outer: for (let row = 1; row <= 6; row++) for (const col of [0, -1, 1, -2, 2]) for (const side of [-1, 1]) {
      box = { x: clamp(anchor.x + col * 28 * scale, bounds.x + r, bounds.x + bounds.w - r) - r,
        y: clamp(anchor.y + side * row * 28 * scale, bounds.y + r, bounds.y + bounds.h - r) - r, w: 2*r, h: 2*r };
      if (!occupied.some(other => overlaps(box, other))) break outer;
    }
    occupied.push(box);
    return { index, issue, x: box.x + r, y: box.y + r, box };
  });
}

/** Fit a field label around its anchor, preserving the preferred side before trying nearby slots. */
export function placeFieldLabel(anchor, width, height, bounds, scale, obstacles, side = true) {
  width = Math.min(width, bounds.w - 8*scale);
  let best;
  for (let row = 0; row <= 6; row++) for (const offset of row ? [-row, row] : [0]) for (const direction of [1,-1]) {
    const x0 = side ? anchor.x + (direction > 0 ? 16*scale : -16*scale-width) : anchor.x + 13*scale;
    const y0 = side ? anchor.y - height/2 + offset*28*scale : anchor.y + (direction > 0 ? -30*scale : 11*scale) + offset*28*scale;
    const box = { x:clamp(x0,bounds.x+4*scale,bounds.x+bounds.w-width-4*scale), y:clamp(y0,bounds.y+4*scale,bounds.y+bounds.h-height-4*scale), w:width, h:height };
    const collision = obstacles.reduce((sum,other)=>sum+overlapArea(box,other),0);
    const score = collision*1000 + Math.hypot(box.x-x0,box.y-y0) + Math.abs(offset)*28*scale;
    if (!best || score < best.score) best={...box,score};
    if (!collision && box.x===x0 && box.y===y0) return box;
  }
  return best;
}

let measureContext;
export function fieldTextWidth(text, font) {
  if (!measureContext && typeof document !== 'undefined') measureContext = document.createElement('canvas').getContext('2d');
  if (measureContext) measureContext.font = font;
  return measureContext?.measureText(text).width ?? text.length * 7;
}
export function problemCaption(issue, count, badge, bounds, scale, obstacles = []) {
  const plain = plainProblem(issue, count);
  const width = (fieldTextWidth(plain.text, '11.5px "Space Grotesk", system-ui, sans-serif') + 16) * scale;
  const box = placeFieldLabel(badge,width,20*scale,bounds,scale,obstacles);
  return { ...plain, ...box, width:box.w };
}

export { overlaps as problemBoxesOverlap };
