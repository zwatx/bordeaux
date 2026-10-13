// Plain consequence for a planner issue, from its structured code only. Unknown codes keep the engine's short
// message; nothing is inferred from message text. Values and the engine text stay available as details.

const BY_CODE = {
  "unreachable-acceleration": "Can't speed up in time",
  "unreachable-deceleration": "Can't slow down in time",
  "unreachable-speed": "Too fast to control here",
  "start-velocity": "Start speed too high",
  "goal-velocity": "End speed too high",
  "speed-step": "Speed jumps instantly",
  "linear-velocity": "Over the speed limit",
  "linear-acceleration": "Speeding up too hard",
  "linear-deceleration": "Braking too hard",
  "centripetal-acceleration": "Corner taken too fast",
  "angular-velocity": "Turning too fast",
  "angular-acceleration": "Turning too abruptly",
  "drivetrain-velocity": "Wheels too fast",
  "planner": "Couldn't time this path",
  "planner-error": "Couldn't time this path",
  "planner-fallback": "Couldn't time this path",
};

// What the limit is, for the details line. Keys are the engine's structured constraint labels.
function limitedBy(constraint = "") {
  if (constraint === "linear-acceleration") return "Acceleration";
  if (constraint === "linear-deceleration") return "Braking";
  if (constraint === "motor-acceleration" || constraint.endsWith("motor-force")) return "Motors";
  if (constraint.endsWith("traction-force") || constraint === "chassis-traction") return "Wheel grip";
  if (constraint === "angular-acceleration") return "Turning";
  return null;
}

// Fixable by capping speed over the stretch: the user chooses to add a zone; nothing is repaired silently.
const SPEED_FIXABLE = new Set([
  "unreachable-acceleration", "unreachable-deceleration", "unreachable-speed", "linear-velocity", "linear-acceleration",
  "linear-deceleration", "centripetal-acceleration", "angular-velocity", "angular-acceleration", "drivetrain-velocity",
  "drivetrain-acceleration",
]);

const unit = (u) => (u === "deg/s" ? "°/s" : u === "deg/s²" ? "°/s²" : u || "");
const num = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export const isWholeIssue = (issue) => Boolean(issue.whole) || (issue.f0 <= 0.001 && issue.f1 >= 0.999);

export function plainProblem(issue, waypointCount = 0) {
  let text = BY_CODE[issue.code];
  if (issue.code === "drivetrain-acceleration") {
    const by = limitedBy(issue.constraint);
    text = by === "Motors" ? "Motors overloaded" : by === "Wheel grip" ? "Wheels would slip" : "Drive overloaded";
  }
  if (issue.code === "boundary-velocity") text = issue.f0 < 0.5 ? "Start speed doesn't match" : "End speed doesn't match";
  if (!text) text = issue.message || "Problem";

  let values = null;
  const u = unit(issue.unit);
  if (Number.isFinite(issue.measured) && Number.isFinite(issue.limit) && u) {
    if (issue.code === "boundary-velocity") values = `${num(issue.measured)} ${u} · expected ${num(issue.limit)} ${u}`;
    else values = `${num(issue.measured)} ${u} needed · limit ${num(issue.limit)} ${u}`;
  } else if (issue.code === "speed-step" && Number.isFinite(issue.measured)) values = `Jumps ${num(issue.measured)} ${u || "m/s"}`;

  const whole = isWholeIssue(issue);
  let where = whole ? "Whole path" : null;
  if (!whole && Number.isInteger(issue.waypoint) && issue.f1 - issue.f0 < 1e-6) where = `Point ${issue.waypoint + 1}`;
  else if (!whole && Number.isInteger(issue.segment) && issue.segment + 1 < waypointCount) where = `Points ${issue.segment + 1}–${issue.segment + 2}`;

  return {
    text,
    where,
    values,
    by: limitedBy(issue.constraint),
    engine: issue.message && issue.message !== text ? issue.message : null,
    fixable: !whole && SPEED_FIXABLE.has(issue.code),
  };
}
