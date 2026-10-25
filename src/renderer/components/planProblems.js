import { UnitPrefs, formatAngularLimit } from '../lib/unitPreferences';

// Plain consequence for a planner issue, chosen from its structured code only. Unknown codes keep the
// engine's short message; nothing is inferred from message text. The engine text stays available as details.
// Measured and limit values are canonical; they convert to display units here, like the controls beside them.

const BY_CODE = {
  'unreachable-acceleration': 'Can’t speed up in time',
  'unreachable-deceleration': 'Can’t slow down in time',
  'unreachable-speed': 'Too fast to control here',
  'start-velocity': 'Start speed too high',
  'goal-velocity': 'End speed too high',
  'speed-step': 'Speed jumps instantly',
  'linear-velocity': 'Over the speed limit',
  'linear-acceleration': 'Speeding up too hard',
  'linear-deceleration': 'Braking too hard',
  'centripetal-acceleration': 'Corner taken too fast',
  'angular-velocity': 'Turning too fast',
  'angular-acceleration': 'Turning too abruptly',
  'drivetrain-velocity': 'Wheels too fast',
  'electrical-power': 'Battery or motor current overloaded',
  planner: 'Couldn’t time this path',
  'planner-error': 'Couldn’t time this path',
  'planner-fallback': 'Couldn’t time this path',
};

function limitedBy(constraint = '') {
  if (constraint === 'linear-acceleration') return 'Acceleration';
  if (constraint === 'linear-deceleration') return 'Braking';
  if (constraint === 'motor-acceleration' || constraint.endsWith('motor-force')) return 'Motors';
  if (constraint.endsWith('traction-force') || constraint === 'chassis-traction') return 'Wheel grip';
  if (constraint === 'angular-acceleration') return 'Turning';
  return null;
}

// Capping speed over the stretch can fix these; the user chooses to add the zone.
const SPEED_FIXABLE = new Set([
  'unreachable-acceleration', 'unreachable-deceleration', 'unreachable-speed', 'linear-velocity', 'linear-acceleration',
  'linear-deceleration', 'centripetal-acceleration', 'angular-velocity', 'angular-acceleration', 'drivetrain-velocity',
  'drivetrain-acceleration',
]);

const ANGULAR = { 'deg/s': '°/s', 'deg/s²': '°/s²' };
const number = (value) => Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);

export const isWholeIssue = (issue) => Boolean(issue.whole) || (issue.f0 <= 0.001 && issue.f1 >= 0.999);

export function plainProblem(issue, waypointCount = 0, units = UnitPrefs) {
  let text = BY_CODE[issue.code];
  if (issue.code === 'drivetrain-acceleration') {
    const by = limitedBy(issue.constraint);
    text = by === 'Motors' ? 'Motors overloaded' : by === 'Wheel grip' ? 'Wheels would slip' : 'Drive overloaded';
  }
  if (issue.code === 'boundary-velocity') text = issue.f0 < 0.5 ? 'Start speed doesn’t match' : 'End speed doesn’t match';
  if (!text) text = issue.message || 'Problem';

  let values = null;
  const canonical = issue.unit || (issue.code === 'speed-step' ? 'm/s' : '');
  const unit = ANGULAR[canonical] || units.label(canonical);
  // Keep each displayed quantity together when the summary wraps.
  const shown = (value) => (ANGULAR[canonical] ? formatAngularLimit : number)(units.fromCanonical(value, canonical)) + ' ' + unit;
  if (Number.isFinite(issue.measured) && Number.isFinite(issue.limit) && unit) {
    values = issue.code === 'boundary-velocity'
      ? shown(issue.measured) + ' · expected ' + shown(issue.limit)
      : shown(issue.measured) + ' needed · limit ' + shown(issue.limit);
  } else if (issue.code === 'speed-step' && Number.isFinite(issue.measured)) values = 'Jumps ' + shown(issue.measured);

  const whole = isWholeIssue(issue);
  let where = whole ? 'Whole path' : null;
  if (!whole && Number.isInteger(issue.waypoint) && issue.f1 - issue.f0 < 1e-6) {
    where = issue.waypoint === 0 ? 'Start' : issue.waypoint === waypointCount - 1 ? 'End' : 'Waypoint ' + issue.waypoint;
  }
  else if (!whole && Number.isInteger(issue.segment) && issue.segment + 1 < waypointCount) where = 'Segment ' + (issue.segment + 1);

  return {
    text, where, values, by: limitedBy(issue.constraint),
    engine: issue.message && issue.message !== text ? issue.message : null,
    fixable: !whole && SPEED_FIXABLE.has(issue.code),
  };
}
