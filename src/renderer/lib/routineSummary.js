import { AUTO } from "./routineModel";

const plural = (count, singular) => count + ' ' + singular + (count === 1 ? '' : 's');
/** How the library's routine time counts branches and repeats, said once in each row's tooltip. */
export const ROUTINE_SUMMARY_SCOPE = 'Preview time with the first route of each branch, every pass of a fixed repeat and one pass of a repeat that stops on a result.';

/**
 * A routine's library row, `{ status, label, title, problems, severity }`, without planning anything.
 *
 * `times` is the library's path times (createLibraryDurations): every path's time and planned end poses are already
 * known there, so AUTO.buildRun traces the routine over them as if they were its plans. The trace is the routine's
 * default preview, what opening it first shows (ROUTINE_SUMMARY_SCOPE), with Robot page run time estimates and limits
 * marked as in the transport. `status` is 'empty' without steps, 'pending' while a path it can follow is still being
 * timed, 'unavailable' when one cannot be timed or the routine cannot be traced, else 'ready'.
 *
 * Problems are what the flow marks: the routine's own issues (AUTO.analyze: missing paths, unchosen or unknown
 * commands, incomplete stops and the like), paths without a time, and pose jumps on the default trace. `severity` is
 * 'bad' when any is an error, 'warn' for warnings and pose jumps, else null.
 */
export function routineSummary(routine, paths, times, robot, catalog) {
  const problems = [];
  let severity = null;
  const flag = (text, level) => {
    if (!problems.includes(text)) problems.push(text);
    if (level === 'bad' || !severity) severity = level;
  };
  // An unreachable step is dimmed in the flow, not marked as a problem.
  for (const issue of AUTO.analyze(routine, paths, catalog)) {
    if (issue.code === 'unreachable') continue;
    flag(AUTO.nodeTitle(AUTO.findNode(routine, issue.nodeId), paths, catalog) + ': ' + issue.message, issue.severity === 'error' ? 'bad' : 'warn');
  }
  AUTO.walk(routine.nodes, (node) => {
    const deployment = AUTO.nodeDeploymentState(node, catalog);
    if (deployment.legacy) flag(AUTO.nodeTitle(node, paths, catalog) + ': Legacy step', 'warn');
    else if (node.type === 'generatedTrajectory') flag(AUTO.nodeTitle(node, paths, catalog) + ': Unsupported saved definition', 'warn');
  });
  const values = {};
  const libraryPaths = new Set(paths);
  let pending = false, untimed = false;
  for (const path of AUTO.planningPaths(routine, paths)) {
    if (!libraryPaths.has(path)) {
      untimed = true;
      flag(path.name + ': Its saved reference path is timed in the routine preview.', 'warn');
      continue;
    }
    const time = times?.[path.id];
    if (time?.status === 'ready' && time.ends) {
      const sample = (pose, t) => ({ t, x: pose.x, y: pose.y, headingRad: pose.heading, velocityMps: 0, s: 0, f: 0 });
      values[path.id] = { finalTrajectory: { totalTimeS: time.seconds, samples: [sample(time.ends.start, 0), sample(time.ends.end, time.seconds)] } };
    } else if (time?.status === 'error' || (path.waypoints?.length || 0) < 2) {
      untimed = true;
      flag(path.name + ': ' + (time?.status === 'error' ? time.message : 'not timed yet; place at least two waypoints'), 'bad');
    } else pending = true;
  }
  const result = (status, label, notes = []) => ({ status, label, severity,
    problems, title: [status === 'ready' ? ROUTINE_SUMMARY_SCOPE : null, ...notes, ...problems].filter(Boolean).join('\n') || undefined });
  if (!routine.nodes.length) return result('empty', '—', ['No steps yet']);
  if (untimed) return result('unavailable', '—', ['Preview time unavailable']);
  if (pending) return result('pending', '…', ['Computing preview time']);
  const run = AUTO.buildRun(routine, paths, robot, {}, undefined, null, { status: 'ready', values });
  if (run.blocked) {
    // A missing path is already named by its own issue.
    if (severity !== 'bad') flag(run.planningError, 'bad');
    return result('unavailable', '—', ['Preview time unavailable']);
  }
  const jumps = run.issues.filter((issue) => issue.code === 'reference-discontinuity').length;
  if (jumps) flag(plural(jumps, 'pose jump') + ' between paths', 'warn');
  const notes = [...AUTO.durationNotes(run), run.truncated && 'Preview stops at 2,000 steps'].filter(Boolean);
  return result('ready', run.timedPlayable ? AUTO.previewTotalLabel(run) : 'Untimed', notes);
}
