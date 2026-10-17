import { describe, expect, it } from 'vitest';
import { AUTO } from '../src/renderer/lib/routineModel';

const end = (id, scope = 'routine') => ({ id, type: 'end', scope });
const branch = (id, yes, no) => ({ id, type: 'decision', cond: 'ready', then: yes, else: no });
const repeat = (id, nodes) => ({ id, type: 'repeat', times: 3, nodes });
const path = (id) => ({ id, type: 'path', ref: 'p' });

describe('authored routine flow summaries', () => {
  it('joins only a route that can fall through, independently of preview choices', () => {
    const yes = [end('stop')], no = [path('drive')];
    expect(AUTO.flowSummary(yes)).toEqual({ normal: false, endRoutine: true, exitRepeat: false });
    expect(AUTO.flowSummary(no)).toEqual({ normal: true, endRoutine: false, exitRepeat: false });
    expect(AUTO.flowSummary([branch('choose', yes, no)])).toEqual({ normal: true, endRoutine: true, exitRepeat: false });
    expect(AUTO.flowSummary([branch('both-stop', yes, [end('other-stop')]), path('unreachable')])).toEqual({ normal: false, endRoutine: true, exitRepeat: false });
  });

  it('shows an empty route as continuation and stops at an unconditional terminal', () => {
    expect(AUTO.flowSummary([])).toEqual({ normal: true, endRoutine: false, exitRepeat: false });
    expect(AUTO.flowSummary([end('stop'), end('unreachable-exit', 'repeat')])).toEqual({ normal: false, endRoutine: true, exitRepeat: false });
  });

  it('distinguishes a repeat-body loop-back from leaving the nearest repeat', () => {
    const body = [branch('choose', [end('exit', 'repeat')], []), end('later-stop')];
    expect(AUTO.flowSummary(body)).toEqual({ normal: false, endRoutine: true, exitRepeat: true });
    expect(AUTO.flowSummary([repeat('loop', body), path('after')])).toEqual({ normal: true, endRoutine: true, exitRepeat: false });
    expect(AUTO.flowSummary([repeat('inner', [end('exit', 'repeat')]), path('outer-body')])).toEqual({ normal: true, endRoutine: false, exitRepeat: false });
  });

  it('uses command-result routes and preserves source with a shared render cache', () => {
    const source = [{ id: 'command', type: 'function', cat: 'command', outputBranch: { routes: [
      { id: 'a', nodes: [end('stop')] }, { id: 'b', nodes: [end('exit', 'repeat')] },
    ] } }];
    const before = structuredClone(source), cache = new WeakMap();
    expect(AUTO.flowSummary(source, cache)).toEqual({ normal: false, endRoutine: true, exitRepeat: true });
    expect(AUTO.flowSummary(source, cache)).toEqual({ normal: false, endRoutine: true, exitRepeat: true });
    expect(source).toEqual(before);
  });
});
