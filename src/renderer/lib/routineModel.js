import { routineChildLists as childLists } from "../../shared/routineChildren";
import { robotValueSchemasEqual } from "../../shared/robotValueSchema";
import { robotParameterValueError, robotSchemaValueError } from "../../shared/robotCommands";
import { PM } from "./pathMath";
import { createRoutineNodeId } from "../../shared/project/ids";

// Autonomous Routine — autonomous routine model + run engine (no React).
// A routine is an ordered list of STEPS. Three step kinds: Path, Decision, Function.
// A Function carries a runtime capability or a generated Robot command.
// Autonomous Routine is robot-agnostic: it ORCHESTRATES runtime generation, it does not define behaviors.
  // ---- runtime capabilities a Function can carry ----
  const CATS = {
    command:   { id: 'command',   label: 'Command',   icon: 'bolt',     color: '#4fbf78', blurb: 'Run a robot command between paths' },
    terminate: { id: 'terminate', label: 'Terminate', icon: 'stop',    color: '#d2655f', blurb: 'End the running path early and advance' },
    sequence:  { id: 'sequence',  label: 'Sequence',  icon: 'shuffle',  color: '#8a7bf0', blurb: 'Skip, repeat, jump, reorder paths' },
    generate:  { id: 'generate',  label: 'Generate',  icon: 'compass',  color: '#cf962f', blurb: 'Invoke a runtime path function' },
    velocity:  { id: 'velocity',  label: 'Velocity',  icon: 'gauge',    color: '#2bb3c4', blurb: 'Scale drive velocities live' },
  };
  const AUTHORABLE_STEPS = [
    { id: 'path', type: 'path', label: 'Path', description: 'Follow a planned trajectory', icon: 'route', color: 'var(--accent)' },
    { id: 'command', type: 'function', cat: 'command', label: 'Command', description: 'Run a generated robot command between paths', icon: 'bolt', color: '#4fbf78' },
    { id: 'decision', type: 'decision', label: 'Branch on condition', icon: 'branch' },
    { id: 'repeat', type: 'repeat', label: 'Repeat', icon: 'repeat' },
    { id: 'end', type: 'end', cat: 'routine', label: 'End routine', icon: 'stop' },
    { id: 'wait', type: 'builtin', cat: 'wait', label: 'Wait', description: 'Pause the routine before its next step', icon: 'pause', color: '#cf962f' },
  ];

  function branches(node) {
    if (node.type === 'decision') return [
      { id: 'then', label: node.thenLabel || 'True', nodes: node.then || [], operator: 'eq', value: true },
      { id: 'else', label: node.elseLabel || 'False', nodes: node.else || [], operator: 'eq', value: false },
    ];
    if (node.type === "repeat") return [{ id: "body", label: "Repeat", nodes: node.nodes || [] }];
    if (node.type === "generatedTrajectory" && node.fallback?.type === "branch") return [{ id: "fallback", label: "Fallback", nodes: node.fallback.nodes || [], readOnly: true }];
    return node.outputBranch?.routes || [];
  }

  function selectedBranch(node, outcomes) {
    const routes = branches(node);
    return routes.find((route) => route.id === outcomes?.[node.id]) || routes[0];
  }

  function branchOutputs(command) {
    return (command?.outputs || []).filter((output) =>
      ['boolean', 'enum', 'number', 'integer', 'integerString', 'decimalString'].includes(output.schema?.kind)
      && (output.schema.kind !== 'enum' || output.schema.enumValues.length <= 255));
  }

  function newOutputBranch(output) {
    const route = (label, operator, value) => ({ id: createRoutineNodeId(), label, operator,
      ...(value !== undefined ? { value } : {}), nodes: [] });
    const kind = output.schema.kind;
    const routes = kind === 'boolean' ? [route('True', 'eq', true), route('False', 'eq', false)]
      : kind === 'enum' ? [...output.schema.enumValues.map((value) => route(value, 'eq', value)), route('Otherwise', 'otherwise')]
      : [route('Match', 'gte', kind.endsWith('String') ? '0' : 0), route('Otherwise', 'otherwise')];
    return { output: output.name, schema: output.schema, routes };
  }

  function routeSteps(routes) {
    return routes.reduce((count, route) => count + branchCount(route.nodes), 0);
  }

  /** Computes one explicit branch edit from live data; the caller owns history and input admission. */
  function branchEdit(branch, outputs, intent) {
    const refused = { status: 'refused', removed: 0 }, unchanged = { status: 'unchanged', removed: 0 };
    const applied = (next, removed = 0) => ({ status: 'applied', branch: next, removed });
    if (intent.kind === 'output') {
      if (intent.output === (branch?.output || '')) return unchanged;
      if (intent.output === '') return applied(undefined, routeSteps(branch.routes));
      const output = outputs.find((item) => item.name === intent.output);
      return output ? applied(newOutputBranch(output), routeSteps(branch?.routes || [])) : refused;
    }
    if (intent.kind === 'rebuild') {
      const output = outputs.find((item) => item.name === branch?.output);
      return !branch || !output || robotValueSchemasEqual(output.schema, branch.schema)
        ? unchanged : applied(newOutputBranch(output), routeSteps(branch.routes));
    }
    if (!branch) return refused;
    const routes = branch.routes, index = routes.findIndex((route) => route.id === intent.routeId), route = routes[index];
    const numeric = ['number', 'integer', 'integerString', 'decimalString'].includes(branch.schema.kind);
    if (intent.kind === 'addComparison') {
      if (!numeric) return refused;
      if (routes.length >= 256) return unchanged;
      const added = newOutputBranch({ name: branch.output, schema: branch.schema }).routes[0];
      return applied({ ...branch, routes: [...routes.slice(0, -1), added, routes.at(-1)] });
    }
    if (!route) return refused;
    if (intent.kind === 'removeRoute') {
      return !numeric || route.operator === 'otherwise' || routes.length <= 2 ? refused
        : applied({ ...branch, routes: routes.filter((item) => item.id !== route.id) }, branchCount(route.nodes));
    }
    if (intent.kind === 'routeEarlier') {
      if (!numeric || route.operator === 'otherwise') return refused;
      if (!index) return unchanged;
      const next = routes.slice(); [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return applied({ ...branch, routes: next });
    }
    if (intent.kind !== 'patchRoute') return refused;
    const patch = intent.patch || {}, allowed = {};
    if (Object.hasOwn(patch, 'label')) {
      if (typeof patch.label !== 'string') return refused;
      if (patch.label.trim()) allowed.label = patch.label.trim();
    }
    if (Object.hasOwn(patch, 'operator') || Object.hasOwn(patch, 'value')) {
      if (!numeric || route.operator === 'otherwise') return refused;
      if (Object.hasOwn(patch, 'operator')) {
        if (!['eq', 'neq', 'lt', 'lte', 'gt', 'gte'].includes(patch.operator)) return refused;
        allowed.operator = patch.operator;
      }
      if (Object.hasOwn(patch, 'value')) {
        const current = outputs.find((item) => item.name === branch.output);
        // A changed catalog output keeps the old routes until explicit rebuild; its bounds belong to its new schema.
        const output = current && robotValueSchemasEqual(current.schema, branch.schema) ? current : null;
        if (robotParameterValueError(patch.value, { ...output, name: branch.output, schema: branch.schema })
          || branch.schema.valueType === 'SGL' && !Number.isFinite(Math.fround(patch.value))) return refused;
        allowed.value = patch.value;
      }
    }
    if (Object.keys(allowed).every((key) => allowed[key] === route[key])) return unchanged;
    return applied({ ...branch, routes: routes.map((item) => item.id === route.id ? { ...item, ...allowed } : item) });
  }

  function routeSummary(route) {
    if (route.operator === 'otherwise') return 'Otherwise';
    const symbols = { eq: '=', neq: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' };
    return (symbols[route.operator] || '=') + ' ' + String(route.value);
  }

  function authoritativeConditions(catalog) {
    if (!catalog || catalog.authoritative !== true || !['1.1', '1.2', '1.3'].includes(catalog.generatedSchemaVersion)) return [];
    return (catalog.conditions || []).map((condition) => ({
      value: condition.id,
      label: condition.label,
      meta: condition.description || condition.id,
    }));
  }

  function conditionPickerItems(conditions, value, empty) {
    const registered = conditions || [];
    const out = [{ value: '', label: empty || 'Choose a registered condition', meta: 'No condition selected' }, ...registered];
    if (value && !registered.some((condition) => condition.value === value)) {
      out.splice(1, 0, { value, label: value, meta: 'Unavailable in the linked generated catalog; replace or remove it before export', badge: 'invalid' });
    }
    return out;
  }

  function hasWaitBuiltIn(catalog) {
    return Boolean(catalog && catalog.authoritative === true && (catalog.generatedSchemaVersion === '1.2' || catalog.generatedSchemaVersion === '1.3')
      && Array.isArray(catalog.builtIns)
      && catalog.builtIns.some((builtIn) => builtIn && builtIn.id === 'bordeaux.wait' && builtIn.kind === 'wait'));
  }

  function authorableSteps(catalog) {
    return AUTHORABLE_STEPS.filter((step) => step.id !== 'wait' || hasWaitBuiltIn(catalog));
  }

  function trajectoryGenerator(catalog, generatorId) {
    return catalog && catalog.authoritative === true && catalog.generatedSchemaVersion === '1.3'
      && Array.isArray(catalog.trajectoryGenerators)
      ? catalog.trajectoryGenerators.find((generator) => generator && generator.id === generatorId)
      : null;
  }

  function nodeDeploymentState(node, catalog) {
    if (!node || typeof node !== 'object') return { deployable: false, legacy: false, label: 'Unknown step' };
    if ((node.type === 'function' && node.cat === 'command' || node.type === 'builtin' && node.builtinId === 'bordeaux.wait') && node.ends !== undefined) return { deployable: false, legacy: false, editable: true, label: node.type === 'builtin' ? 'Wait' : 'Command' };
    if (node.type === 'repeat' || node.type === 'end') return { deployable: false, legacy: false, editable: true, label: node.type === 'repeat' ? 'Repeat' : 'End' };
    if (node.type === 'path' || node.type === 'decision') return { deployable: true, legacy: false };
    if (node.type === 'builtin' && node.builtinId === 'bordeaux.wait') return { deployable: true, legacy: false };
    if (node.type === 'generatedTrajectory') {
      const generator = trajectoryGenerator(catalog, node.generatorId);
      return { deployable: Boolean(generator), legacy: false, dynamic: true, label: generator ? generator.label : 'Runtime dynamic trajectory' };
    }
    if (node.type === 'function' && node.cat === 'command') return { deployable: true, legacy: false };
    if (node.type === 'function' && CATS[node.cat]) return { deployable: false, legacy: true, label: CATS[node.cat].label };
    return { deployable: false, legacy: false, label: 'Unknown step' };
  }

  // ---- Sequence is a CORE Autonomous Routine feature: orchestration ops, robot-independent ----
  const SEQ_OPS = [
    { id: 'skip',    label: 'Skip path',         verb: 'Skip',        blurb: 'Skip the next path in the routine' },
    { id: 'repeat',  label: 'Repeat path',       verb: 'Repeat',      blurb: 'Run a path again before continuing' },
    { id: 'jump',    label: 'Jump to path',      verb: 'Jump to',     blurb: 'Continue the routine from another path' },
    { id: 'reorder', label: 'Reorder remaining', verb: 'Reorder',     blurb: 'Re-sequence the paths still ahead' },
    { id: 'insert',  label: 'Insert path',       verb: 'Insert',      blurb: 'Splice a path into the live sequence' },
    { id: 'remove',  label: 'Remove path',       verb: 'Remove',      blurb: 'Drop an upcoming path from the sequence' },
  ];
  const seqOp = (id) => SEQ_OPS.find((o) => o.id === id) || SEQ_OPS[0];

  // ---- display title for any node ----
  function nodeTitle(node, paths, catalog) {
    if (!node || typeof node !== 'object') return 'Unknown step';
    if (node.type === 'repeat') return `Repeat ${node.times} times`;
    if (node.type === 'end') return node.scope === 'repeat' ? 'Exit repeat' : 'End routine';
    if (node.type === 'path') { const p = paths && paths.find((path) => path.id === node.ref); return p ? p.name : node.ref ? 'Unavailable path' : 'Choose a path'; }
    if (node.type === 'decision') return node.cond || 'Choose condition';
    if (node.type === 'builtin') return node.builtinId === 'bordeaux.wait' ? 'Wait' : 'Unsupported built-in';
    if (node.type === 'generatedTrajectory') {
      const generator = trajectoryGenerator(catalog, node.generatorId);
      return `${generator ? generator.label : (node.generatorId || 'Generated trajectory')}, Runtime dynamic`;
    }
    if (node.cat === 'command') return node.title || (node.invocation && node.invocation.commandId) || 'Choose command';
    if (node.cat === 'generate') return node.funcRef || 'GeneratePath';
    if (node.cat === 'sequence') { const o = seqOp(node.op); return o.verb + (node.target ? ', ' + node.target : ''); }
    return node.title || (CATS[node.cat] && CATS[node.cat].label) || 'Unknown step';
  }

  // ---- node factory ----
  function newNode(type, cat, pathRef) {
    const id = createRoutineNodeId();
    if (type === 'repeat') return { id, type: 'repeat', times: 2, nodes: [] };
    if (type === 'end') return { id, type: 'end', scope: cat === 'repeat' ? 'repeat' : 'routine' };
    if (type === 'path') return { id, type: 'path', ref: pathRef || '' };
    if (type === 'decision') return { id, type: 'decision', cond: '', thenLabel: 'Yes', elseLabel: 'No', then: [], else: [] };
    if (type === 'builtin' && cat === 'wait') return { id, type: 'builtin', builtinId: 'bordeaux.wait', arguments: { durationS: 1 } };
    const c = cat || 'terminate';
    if (c === 'command') return { id, type: 'function', cat: 'command', title: 'Robot command', invocation: null };
    if (c === 'generate') return { id, type: 'function', cat: 'generate', funcRef: 'GeneratePath', trigger: 'On entry', params: [], note: '', preview: null };
    if (c === 'sequence') return { id, type: 'function', cat: 'sequence', op: 'skip', target: '', trigger: 'When condition is true', note: '' };
    if (c === 'velocity') return { id, type: 'function', cat: 'velocity', title: 'Velocity rule', trigger: 'When condition is true', scale: 0.5, note: '' };
    return { id, type: 'function', cat: 'terminate', title: 'Terminate', trigger: 'When condition is true', note: '' };
  }

  // ---- walk every node (incl. branch children) ----
  function walk(nodes, fn, depth = 0, branch = null) {
    const stack = [{ nodes: Array.isArray(nodes) ? nodes : [], index: 0, depth, branch }]; let count = 0;
    while (stack.length && count < 100000) {
      const frame = stack.at(-1);
      if (frame.depth > 64 || frame.index >= frame.nodes.length) { stack.pop(); continue; }
      const node = frame.nodes[frame.index++]; if (!node || typeof node !== 'object') continue;
      count++; fn(node, frame.depth, frame.branch);
      const lists = childLists(node);
      for (let index = lists.length - 1; index >= 0; index--) stack.push({ nodes: lists[index].nodes || [], index: 0, depth: frame.depth + 1, branch: lists[index].ref.route || lists[index].ref.routeId || lists[index].ref.kind });
    }
  }
  function findNode(routine, id) { let hit = null; walk(routine.nodes, (n) => { if (n.id === id) hit = n; }); return hit; }
  function countSteps(routine) { let n = 0; walk(routine.nodes, () => n++); return n; }

  // Every path document the routine can follow in any branch, once each.
  function planningPaths(routine, paths) {
    const referenced = new Map();
    walk(routine.nodes, (node) => {
      if (node.type === 'path') {
        const path = paths.find((candidate) => candidate.id === node.ref);
        if (path) referenced.set(path.id, path);
      } else if (node.type === 'function' && node.cat === 'generate' && node.preview) {
        referenced.set(node.preview.id, node.preview);
      }
    });
    return [...referenced.values()];
  }

  // ---- derive a path-bearing node into a field trajectory ----
  function derivePathNode(node, pathsById, robot, plannerId, plannedPaths, derivedPaths, derivePath = PM.derivePath) {
    let doc = null;
    if (node.type === 'path') doc = pathsById.get(node.ref);
    else if (node.type === 'function' && node.cat === 'generate' && node.preview) doc = node.preview;
    if (!doc) return null;
    if (derivedPaths.has(doc)) return derivedPaths.get(doc);
    const planned = plannedPaths && plannedPaths[doc.id];
    if (plannedPaths && !planned) return null;
    const d = planned || derivePath(doc, robot, 56, plannerId);
    const trajectory = d.finalTrajectory || null;
    const result = {
      doc,
      deriv: d,
      trajectory,
      pts: trajectory ? trajectory.samples : (d.sample?.pts || []),
      total: trajectory ? trajectory.totalTimeS : d.prof?.totalTime || 0,
    };
    derivedPaths.set(doc, result);
    return result;
  }

  function trajectoryPoseAt(trajectory, time) {
    const samples = trajectory && trajectory.samples;
    if (!samples || !samples.length) return null;
    if (samples.length === 1 || time <= samples[0].t) {
      const sample = samples[0];
      return { x: sample.x, y: sample.y, heading: sample.headingRad, speed: sample.velocityMps, s: sample.s, f: sample.f };
    }
    if (time >= samples[samples.length - 1].t) {
      const sample = samples[samples.length - 1];
      return { x: sample.x, y: sample.y, heading: sample.headingRad, speed: sample.velocityMps, s: sample.s, f: sample.f };
    }
    let low = 1, high = samples.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (samples[middle].t < time) low = middle + 1;
      else high = middle;
    }
    const after = samples[low], before = samples[low - 1];
    const ratio = Math.max(0, Math.min(1, (time - before.t) / Math.max(1e-9, after.t - before.t)));
    const headingDelta = Math.atan2(
      Math.sin(after.headingRad - before.headingRad),
      Math.cos(after.headingRad - before.headingRad),
    );
    const lerp = (first, second) => first + (second - first) * ratio;
    return {
      x: lerp(before.x, after.x),
      y: lerp(before.y, after.y),
      heading: before.headingRad + headingDelta * ratio,
      speed: lerp(before.velocityMps, after.velocityMps),
      s: lerp(before.s, after.s),
      f: lerp(before.f, after.f),
    };
  }

  // A display trace of local choices, never execution or predicate evaluation.
  function buildRun(routine, paths, robot, outcomes, plannerId, catalog, plannedPaths, viewOptions = {}) {
    const derivePath = typeof catalog === 'function' ? catalog : PM.derivePath;
    if (typeof catalog === 'function') catalog = null;
    const issues = [], assumptions = ['Routes are chosen locally and apply to every occurrence.', 'Commands are assumed to complete naturally; conditions and outputs are not evaluated.', 'Poses are planned references; command motion is unknown.'];
    const result = { steps: [], segs: [], total: 0, duration: { minS: 0, maxS: 0, unknownCount: 0, usesLimits: false },
      truncated: false, stopReason: 'complete', assumptions, issues, timedPlayable: false, workCount: 0 };
    const invalid = message => { result.blocked = true; result.stopReason = 'invalid'; result.planningError = message; issues.push({ code: 'preview-invalid', severity: 'error', message }); };
    if (plannedPaths?.status && plannedPaths.status !== 'ready') {
      invalid(plannedPaths.error || 'Paths are not ready.'); result.planningStatus = plannedPaths.status; return result;
    }
    // Independent authored-tree budget prevents malformed deep/cyclic input from
    // reaching recursive helpers or a planner before the display budget applies.
    const tree = [{ nodes: routine?.nodes, depth: 0 }], ids = new Set(); let authored = 0;
    const pathsById = new Map(paths.map(path => [path.id, path]));
    while (tree.length) {
      const frame = tree.pop();
      if (!Array.isArray(frame.nodes) || frame.depth > 64) { invalid('Routine child shape or depth is invalid.'); return result; }
      for (const node of frame.nodes) {
        if (++authored > 100000 || !node || typeof node !== 'object' || typeof node.id !== 'string' || ids.has(node.id)) { invalid('Routine node budget or identity is invalid.'); return result; }
        ids.add(node.id);
        if (!['path', 'decision', 'builtin', 'function', 'generatedTrajectory', 'repeat', 'end'].includes(node.type)
          || (node.type === 'end' && node.scope !== 'routine' && node.scope !== 'repeat')
          || (node.type === 'repeat' && !Array.isArray(node.nodes))
          || (node.type === 'decision' && (!Array.isArray(node.then) || !Array.isArray(node.else)))
          || (node.outputBranch && !Array.isArray(node.outputBranch.routes))) { invalid('Routine child shape or type is invalid.'); return result; }
        if (node.type === 'path' && !pathsById.has(node.ref)) { invalid(`Referenced path ${node.ref || '(unselected)'} is unavailable.`); return result; }
        if (node.type === 'repeat' && (!Number.isInteger(node.times) || node.times < 1 || node.times > 50)) { invalid('Repeat count must be from 1 to 50.'); return result; }
        for (const list of childLists(node)) tree.push({ nodes: list.nodes, depth: frame.depth + 1 });
      }
    }
    const plannedValues = plannedPaths?.values || plannedPaths;
    const derivedPaths = new Map(), flat = [];
    const frames = [{ kind: 'list', nodes: routine.nodes, index: 0, depth: 0, passStack: [] }];
    const emit = (node, kind, passStack, extra = {}) => {
      if (flat.length >= 2000) { result.truncated = true; result.stopReason = 'limit'; return false; }
      flat.push({ node, nodeId: node.id, kind, occurrenceId: `occurrence-${flat.length + 1}`, passStack: passStack.map(pass => ({ ...pass })), ...extra });
      return true;
    };
    while (frames.length) {
      const frame = frames.at(-1);
      // Finishing a list consumes no expansion work and allows exactly-bound
      // naturally completed traces to remain complete.
      if (frame.kind === 'list' && frame.index >= frame.nodes.length) { frames.pop(); continue; }
      if (frame.kind === 'repeat' && frame.pass >= frame.passes) { frames.pop(); continue; }
      if (++result.workCount > 8000) { result.truncated = true; result.stopReason = 'limit'; break; }
      if (frame.depth > 64) { invalid('Routine nesting exceeds 64 levels.'); break; }
      if (frame.kind === 'repeat') {
        frame.pass++;
        const passStack = [...frame.passStack, { repeatId: frame.node.id, pass: frame.pass }];
        if (!emit(frame.node, 'repeat', passStack, { pass: frame.pass, passes: frame.passes })) break;
        frames.push({ kind: 'list', nodes: frame.node.nodes, index: 0, depth: frame.depth + 1, passStack });
        continue;
      }
      const node = frame.nodes[frame.index++], passStack = frame.passStack;
      if (node.type === 'repeat') {
        const requested = viewOptions.repeatPasses?.[node.id];
        const passes = node.until ? Math.max(1, Math.min(node.times, Number.isInteger(requested) ? requested : 1)) : node.times;
        if (node.until && passes < node.times) assumptions.push(`Repeat ${node.id}: assume its stop check is true after pass ${passes}.`);
        frames.push({ kind: 'repeat', node, pass: 0, passes, depth: frame.depth, passStack }); continue;
      }
      const kind = node.type === 'decision' ? 'decision' : node.type === 'path' ? 'path' : node.type === 'builtin' ? 'wait'
        : node.type === 'end' ? 'end' : node.type === 'generatedTrajectory' ? 'dynamic' : node.cat === 'generate' && node.preview ? 'gen' : 'event';
      if (!emit(node, kind, passStack)) break;
      if (node.type === 'end') {
        if (node.scope === 'routine') { result.stopReason = 'endStep'; frames.length = 0; break; }
        const repeatIndex = frames.findLastIndex(item => item.kind === 'repeat');
        if (repeatIndex < 0) { invalid('Exit repeat has no enclosing repeat.'); break; }
        frames.splice(repeatIndex); continue;
      }
      if (node.type === 'decision') {
        const selected = outcomes?.[node.id] === 'else' ? node.else : node.then;
        frames.push({ kind: 'list', nodes: selected || [], index: 0, depth: frame.depth + 1, passStack });
      } else if (node.outputBranch) {
        const route = selectedBranch(node, outcomes);
        if (route) frames.push({ kind: 'list', nodes: route.nodes || [], index: 0, depth: frame.depth + 1, passStack });
      }
    }
    let t = 0, pIdx = 0, lastPose = null, previousPath = null;
    const continuityEdges = new Set();
    for (const it of flat) {
      let dur = 0, timing = 'instant', extras = { pose: lastPose ? { ...lastPose, speed: 0 } : null };
      if (it.kind === 'path' || it.kind === 'gen') {
        const dp = derivePathNode(it.node, pathsById, robot, plannerId, plannedValues, derivedPaths, derivePath);
        if (!dp || !Array.isArray(dp.pts) || dp.pts.length < 2 || !Number.isFinite(dp.total) || dp.total < 0) { invalid(`Path ${it.node.ref || it.node.id} has no usable authoritative plan.`); break; }
        dur = dp.total; timing = 'exact'; pIdx++;
        const idxLabel = String(pIdx).padStart(2, '0'), label = it.node.type === 'path' ? dp.doc.name : ('Saved reference: ' + dp.doc.name);
        const startPose = dp.trajectory ? trajectoryPoseAt(dp.trajectory, 0) : PM.poseAtTime(0, dp.pts, dp.deriv.prof, dp.deriv.anchors, dp.deriv.mode, dp.deriv.rev);
        if (lastPose && startPose) {
          const distanceM = Math.hypot(lastPose.x - startPose.x, lastPose.y - startPose.y);
          const headingRad = Math.abs(Math.atan2(Math.sin(lastPose.heading - startPose.heading), Math.cos(lastPose.heading - startPose.heading)));
          const edge = JSON.stringify([previousPath, it.node.id]);
          if ((distanceM > .001 || headingRad > .001) && !continuityEdges.has(edge)) {
            continuityEdges.add(edge); issues.push({ nodeId: it.node.id, occurrenceId: it.occurrenceId, code: 'reference-discontinuity', severity: 'warning',
              message: 'The next planned path starts at a different reference pose.', distanceM, headingRad });
          }
        }
        result.segs.push({ nodeId: it.node.id, occurrenceId: it.occurrenceId, passStack: it.passStack, timing, kind: it.kind, label, idxLabel,
          pts: dp.pts, t0: t, t1: t + dur, deriv: dp.deriv, trajectory: dp.trajectory, doc: dp.doc });
        extras = { segIdx: result.segs.length - 1, idxLabel, label, dist: dp.trajectory ? dp.trajectory.totalDistanceM : dp.deriv.sample.length };
        lastPose = dp.trajectory ? trajectoryPoseAt(dp.trajectory, dp.total) : PM.poseAtTime(dp.total, dp.pts, dp.deriv.prof, dp.deriv.anchors, dp.deriv.mode, dp.deriv.rev);
        previousPath = it.node.id;
      } else if (it.kind === 'wait') {
        dur = Math.max(0, Number.isFinite(it.node.arguments?.durationS) ? it.node.arguments.durationS : 0);
        timing = it.node.ends?.endWhen ? 'upperBound' : 'exact';
      } else if (it.kind === 'event' || it.kind === 'dynamic') {
        if (Number.isFinite(it.node.ends?.timeoutS)) { dur = it.node.ends.timeoutS; timing = 'upperBound'; }
        else timing = 'unknown';
        if (it.kind === 'dynamic') extras.dynamic = true;
      }
      if (timing === 'exact') result.duration.minS += dur;
      if (timing === 'unknown') { result.duration.unknownCount++; result.duration.maxS = null; }
      else if (result.duration.maxS !== null) result.duration.maxS += dur;
      if (timing === 'upperBound') result.duration.usesLimits = true;
      result.steps.push({ ...it, t0: t, t1: t + dur, dur, timing, ...extras }); t += dur;
    }
    result.total = t; result.timedPlayable = !result.blocked && t > 0;
    return result;
  }

  // ---- pose along the run at time ----
  function poseAt(run, time, robot) {
    if (!run.steps.length) return null;
    const cur = run.steps[stepIndexAt(run.steps, time, true)];
    if (cur.segIdx != null) {
      const seg = run.segs[cur.segIdx];
      return seg.trajectory
        ? trajectoryPoseAt(seg.trajectory, time - cur.t0)
        : PM.poseAtTime(time - cur.t0, seg.pts, seg.deriv.prof, seg.deriv.anchors, seg.deriv.mode, seg.deriv.rev);
    }
    if (cur.pose) return { x: cur.pose.x, y: cur.pose.y, heading: cur.pose.heading || 0, speed: 0 };
    return null;
  }

  // Steps are emitted in time order, including zero-duration decisions. Find
  // the first matching end so boundary ties retain the previous step's pose.
  function stepIndexAt(steps, time) {
    if (!steps.length) return -1;
    if (!Number.isFinite(time) || time < steps[0].t0) return steps.length - 1;
    if (time >= steps.at(-1).t1) return steps.length - 1;
    let low = 0, high = steps.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (steps[middle].t1 <= time) low = middle + 1;
      else high = middle;
    }
    return Math.min(low, steps.length - 1);
  }

  // ---- which step is current at a time (for highlighting) ----
  function stepAt(run, time) {
    return stepIndexAt(run.steps, time, false);
  }

  // ---- field overlay descriptor for FieldView ----
  function fieldOverlay(run, opts) {
    opts = opts || {};
    const { time, running, selectedId, selectedOccurrenceId } = opts;
    const selHasSeg = !running && selectedId != null && run.segs.some((s) => s.nodeId === selectedId);
    return run.segs.map((seg) => {
      let state;
      if (running && time != null) {
        state = time >= seg.t1 ? 'done' : (time >= seg.t0 ? 'active' : 'pending');
        if (seg.kind === 'gen' && state !== 'pending') state = 'generated';
      } else if (selHasSeg) {
        if (selectedOccurrenceId ? seg.occurrenceId === selectedOccurrenceId : seg.nodeId === selectedId) state = seg.kind === 'gen' ? 'genfocus' : 'focus';
        else state = 'dim';
      } else {
        state = seg.kind === 'gen' ? 'generated' : 'done';
      }
      return { nodeId: seg.nodeId, occurrenceId: seg.occurrenceId, passStack: seg.passStack, label: seg.label, idxLabel: seg.idxLabel, pts: seg.pts, kind: seg.kind, state };
    });
  }

export const AUTO = { childLists, locate, checkEdit, editRoutine, analyze, flowSummary, isResultConsumer, newCommandEnds, branches, selectedBranch, branchOutputs, newOutputBranch, branchEdit, routeSteps, routeSummary, CATS, AUTHORABLE_STEPS, authoritativeConditions, conditionPickerItems, hasWaitBuiltIn, authorableSteps, nodeDeploymentState, nodeTitle, newNode, walk, findNode, countSteps, branchCount,
    planningPaths, buildRun, poseAt, stepAt, fieldOverlay,
    update, remove, insertAfter, prepend, appendBranch, append, move, siblingNodes, canReorderRelative, reorderRelative };

  // ---- immutable-ish routine edits (operate on a deep clone) ----
  function _clone(o) { return JSON.parse(JSON.stringify(o)); }
  function update(routine, id, patch) { const r = _clone(routine); walk(r.nodes, (n) => { if (n.id === id) Object.assign(n, patch); }); return r; }
  function remove(routine, id) {
    const r = _clone(routine);
    const rm = (arr) => { const i = arr.findIndex((n) => n.id === id); if (i >= 0) { arr.splice(i, 1); return true; } for (const n of arr) { if (branches(n).some((route) => rm(route.nodes))) return true; } return false; };
    rm(r.nodes); return r;
  }
  function insertAfter(routine, id, node) {
    const r = _clone(routine);
    const ins = (arr) => { const i = arr.findIndex((n) => n.id === id); if (i >= 0) { arr.splice(i + 1, 0, node); return true; } for (const n of arr) { if (branches(n).some((route) => ins(route.nodes))) return true; } return false; };
    if (!ins(r.nodes)) r.nodes.push(node); return r;
  }
  function prepend(routine, node) { const r = _clone(routine); r.nodes.unshift(node); return r; }
  function appendBranch(routine, decId, branch, node) { const r = _clone(routine); walk(r.nodes, (n) => { if (n.id === decId) { const route = branches(n).find((route) => route.id === branch); if (route) route.nodes.push(node); } }); return r; }
  function append(routine, node) { const r = _clone(routine); r.nodes.push(node); return r; }
  // move a node up/down within its own containing array
  function move(routine, id, dir) {
    const r = _clone(routine);
    const mv = (arr) => {
      const i = arr.findIndex((n) => n.id === id);
      if (i >= 0) { const j = i + dir; if (j < 0 || j >= arr.length) return true; const t = arr[i]; arr[i] = arr[j]; arr[j] = t; return true; }
      for (const n of arr) { if (branches(n).some((route) => mv(route.nodes))) return true; }
      return false;
    };
    mv(r.nodes); return r;
  }
  function siblingNodes(routine, id) {
    const find = (nodes) => {
      if (nodes.some((node) => node.id === id)) return nodes;
      for (const node of nodes) {
        for (const route of branches(node)) {
          const siblings = find(route.nodes);
          if (siblings) return siblings;
        }
      }
      return null;
    };
    return find(routine.nodes);
  }
  function canReorderRelative(routine, id, targetId, before) {
    const siblings = siblingNodes(routine, id);
    if (!siblings || id === targetId) return false;
    const source = siblings.findIndex((node) => node.id === id);
    const target = siblings.findIndex((node) => node.id === targetId);
    if (target < 0) return false;
    return before ? source !== target - 1 : source !== target + 1;
  }
  // Feedback and mutation share the same sibling-only, non-no-op rule.
  function reorderRelative(routine, id, targetId, before) {
    if (!canReorderRelative(routine, id, targetId, before)) return routine;
    const r = _clone(routine);
    const siblings = siblingNodes(r, id);
    const [node] = siblings.splice(siblings.findIndex((item) => item.id === id), 1);
    const target = siblings.findIndex((item) => item.id === targetId);
    siblings.splice(before ? target : target + 1, 0, node);
    return r;
  }
  // total step count inside a branch (recursive)
  function branchCount(nodes) { let c = 0; walk(nodes || [], () => c++); return c; }
  const sameRef = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function locate(routine, id) {
    const stack = [{ nodes: routine?.nodes || [], listRef: { kind: 'root' }, parent: null, repeatIds: [], depth: 0, readOnly: false }];
    let count = 0;
    while (stack.length && count < 100000) {
      const frame = stack.pop();
      if (frame.depth > 64 || !Array.isArray(frame.nodes)) continue;
      for (let index = 0; index < frame.nodes.length; index++) {
        const node = frame.nodes[index]; count++;
        if (node.id === id) return { node, siblings: frame.nodes, index, listRef: frame.listRef, parent: frame.parent, repeatIds: frame.repeatIds, readOnly: frame.readOnly };
        for (const list of childLists(node)) stack.push({ nodes: list.nodes, listRef: list.ref, parent: node,
          repeatIds: node.type === 'repeat' ? [...frame.repeatIds, node.id] : frame.repeatIds, depth: frame.depth + 1, readOnly: frame.readOnly || Boolean(list.readOnly) });
      }
    }
    return null;
  }
  function resolveList(routine, ref) {
    if (!ref || ref.kind === 'fallback') return null;
    if (ref.kind === 'root') return routine.nodes;
    const owner = locate(routine, ref.nodeId);
    return owner && !owner.readOnly && childLists(owner.node).find(list => !list.readOnly && sameRef(list.ref, ref))?.nodes;
  }
  function routineLocations(routine) {
    const locations = new Map(), stack = [{ nodes: routine?.nodes || [], listRef: { kind: 'root' }, parent: null, repeatIds: [], depth: 0, readOnly: false }]; let count = 0;
    while (stack.length && count < 100000) {
      const frame = stack.pop(); if (frame.depth > 64 || !Array.isArray(frame.nodes)) continue;
      for (let index = 0; index < frame.nodes.length && count < 100000; index++) {
        const node = frame.nodes[index]; if (!node || typeof node !== 'object') continue; count++;
        locations.set(node.id, { node, siblings: frame.nodes, index, listRef: frame.listRef, parent: frame.parent, repeatIds: frame.repeatIds, readOnly: frame.readOnly });
        for (const list of childLists(node)) stack.push({ nodes: list.nodes, listRef: list.ref, parent: node, depth: frame.depth + 1,
          repeatIds: node.type === 'repeat' ? [...frame.repeatIds, node.id] : frame.repeatIds, readOnly: frame.readOnly || Boolean(list.readOnly) });
      }
    }
    return locations;
  }
  function scopedBindings(routine) {
    const exits = new Map(), outputs = new Map();
    for (const { node, repeatIds } of routineLocations(routine).values()) {
      if (node.type === 'end' && node.scope === 'repeat') exits.set(node.id, repeatIds.at(-1) || null);
      if (node.type === 'repeat' && node.until?.source === 'output') {
        const producer = node.nodes.find(n => n.id === node.until.nodeId && n.type === 'function' && n.cat === 'command');
        if (producer) outputs.set(node.id, producer.id);
      }
    }
    return { exits, outputs };
  }
  function editRoutine(routine, operation) {
    const fail = reason => ({ changed: false, routine, ...(reason ? { reason } : {}) });
    if (!routine || !Array.isArray(routine.nodes) || !operation) return fail('The routine is unavailable.');
    const before = scopedBindings(routine), result = _clone(routine);
    let focusId;
    if (operation.kind === 'insert' || operation.kind === 'move') {
      const list = resolveList(result, operation.listRef);
      if (!list) return fail('The destination no longer exists or is read-only.');
      if (!Number.isInteger(operation.index) || operation.index < 0 || operation.index > list.length) return fail('Choose a valid insertion position.');
      let index = operation.index, node;
      if (operation.kind === 'move') {
        const source = locate(result, operation.nodeId);
        if (!source || source.readOnly) return fail('The source no longer exists or is read-only.');
        let containsDestination = operation.listRef.nodeId === source.node.id;
        walk(childLists(source.node).flatMap(child => child.nodes), n => { if (n.id === operation.listRef.nodeId) containsDestination = true; });
        if (containsDestination) return fail('A step cannot move inside itself.');
        if (source.siblings === list && (index === source.index || index === source.index + 1)) return fail();
        node = source.siblings.splice(source.index, 1)[0];
        if (source.siblings === list && source.index < index) index--;
      } else {
        node = _clone(operation.node);
        if (!node || typeof node.id !== 'string') return fail('The new step is invalid.');
        const ids = new Set(), existingIds = new Set(routineLocations(routine).keys()); let duplicate = false;
        walk([node], n => { if (ids.has(n.id) || existingIds.has(n.id)) duplicate = true; ids.add(n.id); });
        if (duplicate) return fail('Step IDs must be unique.');
      }
      list.splice(index, 0, node); focusId = node.id;
    } else if (operation.kind === 'wrapRepeat') {
      const ids = operation.nodeIds;
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) return fail('Choose a unique contiguous range.');
      const locations = ids.map(id => locate(result, id));
      if (locations.some(item => !item || item.readOnly)) return fail('The selected steps no longer exist or are read-only.');
      const first = locations[0];
      if (locations.some((item, index) => item.siblings !== first.siblings || item.index !== first.index + index)) return fail('Choose contiguous sibling steps in run order.');
      const times = operation.times ?? 2;
      if (!Number.isInteger(times) || times < 1 || times > 50) return fail('Repeat count must be from 1 to 50.');
      const repeat = { id: operation.repeatId || createRoutineNodeId(), type: 'repeat', times, nodes: first.siblings.splice(first.index, ids.length) };
      if (locate(routine, repeat.id)) return fail('Step IDs must be unique.');
      first.siblings.splice(first.index, 0, repeat); focusId = repeat.id;
    } else if (operation.kind === 'unwrapRepeat') {
      const source = locate(result, operation.nodeId);
      if (!source || source.node.type !== 'repeat' || source.readOnly) return fail('The repeat no longer exists or is read-only.');
      if ([...before.exits.values()].includes(source.node.id)) return fail('Move or remove the exits before removing this repeat.');
      source.siblings.splice(source.index, 1, ...source.node.nodes); focusId = source.node.nodes[0]?.id;
    } else return fail('Unknown edit.');
    const pending = [{ nodes: result.nodes, depth: 0 }], retainedIds = new Set(); let count = 0;
    while (pending.length) {
      const frame = pending.pop();
      if (!Array.isArray(frame.nodes) || frame.depth > 64) return fail('This edit would exceed routine nesting limits.');
      for (const node of frame.nodes) {
        if (++count > 100000 || retainedIds.has(node.id)) return fail('This edit would exceed routine size or duplicate step IDs.');
        retainedIds.add(node.id);
        for (const list of childLists(node)) pending.push({ nodes: list.nodes, depth: frame.depth + 1 });
      }
    }
    const after = scopedBindings(result);
    for (const [id, target] of before.exits) {
      if (after.exits.has(id) && after.exits.get(id) !== target) return fail('This edit would change which repeat an Exit leaves.');
    }
    for (const [id, target] of after.exits) {
      if (!before.exits.has(id) && target === null) return fail('Exit repeat needs an enclosing repeat.');
    }
    for (const [repeatId, producerId] of before.outputs) {
      if (locate(result, repeatId) && after.outputs.get(repeatId) !== producerId) return fail('The stop-result command must remain directly inside its repeat.');
    }
    return { changed: true, routine: result, focusId };
  }
  function checkEdit(routine, operation) {
    const result = editRoutine(routine, operation);
    return { allowed: result.changed, ...(result.reason ? { reason: result.reason } : {}) };
  }
  function isResultConsumer(routine, nodeId) {
    const location = locate(routine, nodeId);
    return Boolean(location?.node.outputBranch || (location?.parent?.type === 'repeat'
      && location.parent.until?.source === 'output' && location.parent.until.nodeId === nodeId));
  }
  function newCommandEnds(routine, nodeId) { return { timeoutS: 2, onTimeout: isResultConsumer(routine, nodeId) ? 'endRoutine' : 'continue' }; }

  // Normal, End routine, and Exit repeat are distinct terminal outcomes.
  // A repeat consumes only its own Exit; route terminals survive later siblings.
  function flowOutcomes(nodes, depth = 0, cache = new WeakMap()) {
    if (!Array.isArray(nodes) || depth > 64) return new Set();
    if (cache.has(nodes)) return cache.get(nodes);
    let outcomes = new Set(['normal']);
    for (const node of nodes) {
      if (!outcomes.has('normal')) break;
      let next;
      if (node.type === 'end') next = new Set([node.scope === 'repeat' ? 'exitRepeat' : 'endRoutine']);
      else if (node.type === 'decision' || node.outputBranch) {
        next = new Set();
        const routes = node.type === 'decision' ? [node.then, node.else] : node.outputBranch.routes.map(route => route.nodes);
        for (const route of routes) for (const value of flowOutcomes(route, depth + 1, cache)) next.add(value);
      } else if (node.type === 'repeat') {
        next = new Set();
        for (const value of flowOutcomes(node.nodes, depth + 1, cache)) next.add(value === 'exitRepeat' ? 'normal' : value);
      } else next = new Set(['normal']);
      outcomes.delete('normal'); for (const value of next) outcomes.add(value);
    }
    cache.set(nodes, outcomes); return outcomes;
  }
  /** Authored control-flow outcomes, independent of the chosen preview trace.
   * A repeat consumes its own Exit; callers inspecting its body can still
   * distinguish leaving the repeat from completing a pass and looping back.
   */
  function flowSummary(nodes, cache) {
    const outcomes = flowOutcomes(nodes, 0, cache);
    return {
      normal: outcomes.has('normal'),
      endRoutine: outcomes.has('endRoutine'),
      exitRepeat: outcomes.has('exitRepeat'),
    };
  }
  function fallsThrough(nodes, cache) { return flowOutcomes(nodes, 0, cache).has('normal'); }
  function analyze(routine, paths = [], catalog = null) {
    const locations = routineLocations(routine), flowCache = new WeakMap();
    const issues = [], conditions = new Set(authoritativeConditions(catalog).map(c => c.value));
    const add = (node, code, message, severity = 'error', details = {}) => issues.push({ nodeId: node.id, code, severity, message, ...details });
    // Without a catalog nothing could be checked, so a saved reference is only described as kept.
    const unavailable = what => 'The saved ' + what + (catalog ? ' is unavailable in the linked catalog.' : ' is kept; no robot code is loaded.');
    const predicate = (node, value) => {
      if (!value?.conditionId) add(node, 'condition-missing', 'Choose a registered condition.');
      else if (!conditions.has(value.conditionId)) add(node, 'condition-unavailable', unavailable('condition'));
    };
    walk(routine?.nodes, node => {
      if (node.type === 'path' && !paths.some(path => path.id === node.ref)) add(node, 'path-missing', 'The referenced path is unavailable.');
      if (node.type === 'decision') predicate(node, { conditionId: node.cond });
      if (node.type === 'end' && node.scope === 'repeat' && !locations.get(node.id)?.repeatIds.length) add(node, 'exit-orphan', 'Exit repeat needs an enclosing repeat.');
      if (node.ends?.endWhen) predicate(node, node.ends.endWhen);
      if (node.ends?.timeoutS !== undefined && !node.ends.onTimeout) add(node, 'timeout-policy-missing', 'Choose what happens at the time limit.');
      if (node.type === 'function' && node.cat === 'command') {
        if (!node.invocation?.commandId) add(node, 'command-missing', 'Choose a robot command.');
        const command = catalog?.commands?.find(command => command.id === node.invocation?.commandId);
        if (node.invocation?.commandId && !command) add(node, 'command-unavailable', unavailable('command'));
        const location = locations.get(node.id);
        const consumer = node.outputBranch || (location?.parent?.type === 'repeat' && location.parent.until?.source === 'output' && location.parent.until.nodeId === node.id);
        if (consumer && (node.ends?.endWhen || (node.ends?.timeoutS !== undefined && node.ends.onTimeout !== 'endRoutine'))) add(node, 'result-needs-completion', 'A result needs the command to finish.');
        if (node.outputBranch) {
          const output = branchOutputs(command).find(output => output.name === node.outputBranch.output);
          if (!output) add(node, 'output-unavailable', 'The saved command output is unavailable.');
          else if (!robotValueSchemasEqual(output.schema, node.outputBranch.schema)) add(node, 'output-schema-changed', 'The command output type changed; choose or repair its routes.');
        }
      }
      if (node.type !== 'repeat') return;
      if (!node.nodes?.length) add(node, 'repeat-empty', 'Add steps to this repeat.');
      if (!Number.isInteger(node.times) || node.times < 1 || node.times > 50) add(node, 'repeat-count', 'Repeat count must be from 1 to 50.');
      if (node.until?.source === 'condition') predicate(node, node.until);
      if (node.until?.source === 'output') {
        const stop = node.until, producer = node.nodes.find(child => child.id === stop.nodeId && child.type === 'function' && child.cat === 'command');
        if (!producer) add(node, 'stop-producer-scope', 'Choose a command directly inside this repeat.');
        const command = catalog?.commands?.find(command => command.id === producer?.invocation?.commandId);
        const output = branchOutputs(command).find(output => output.name === stop.output);
        if (!stop.output || !stop.schema || stop.value === undefined) add(node, 'stop-incomplete', 'Choose an output and stop value.');
        if (!output) add(node, 'stop-output-unavailable', unavailable('stop output'));
        else if (stop.schema && !robotValueSchemasEqual(output.schema, stop.schema)) add(node, 'stop-schema-changed', 'The stop output type changed; repair its comparison.');
        if (stop.schema && !(['boolean', 'enum'].includes(stop.schema.kind) ? ['eq'] : ['eq', 'neq', 'lt', 'lte', 'gt', 'gte']).includes(stop.operator)) add(node, 'stop-operator', 'Choose a comparison supported by this output type.');
        if (stop.schema && stop.value !== undefined) {
          const error = robotSchemaValueError(stop.value, stop.schema, 'Stop value');
          if (error) add(node, 'stop-value', error);
        }
      }
      if (!fallsThrough(node.nodes, flowCache)) {
        add(node, 'repeat-stops-first-pass', 'This repeat cannot complete another pass.', 'warning');
        if (node.until) add(node, 'stop-check-unreachable', 'The after-pass stop check is unreachable.', 'warning');
      }
    });
    const stack = [{ nodes: routine?.nodes || [], depth: 0 }]; let visited = 0;
    while (stack.length && visited < 100000) {
      const { nodes, depth } = stack.pop(); if (depth > 64) continue;
      let reachable = true;
      for (const node of nodes) {
        visited++;
        if (!reachable) add(node, 'unreachable', 'This step cannot be reached.', 'warning');
        for (const list of childLists(node)) stack.push({ nodes: list.nodes, depth: depth + 1 });
        if (!fallsThrough([node], flowCache)) reachable = false;
      }
    }
    return issues;
  }
