// The Robot page's list of command uses: a use inside a generated trajectory's saved fallback can't be edited, so its
// row must not open an inspector. Review round 4, item 11.
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandPowerEditor, CommandPowerSummary } from '../src/renderer/components/CommandPower';
import { commandInputKey } from '../src/core/commandLoads';
import { commandEstimateCapProblem, copyCommandUseEstimate, migrateLegacyCommandLoads, setCommandUseEstimate, storeCommandEstimate } from '../src/core/project/commandPower';
import { createDemoProject } from '../src/core/project/defaults';

function project() {
  const demo = createDemoProject();
  const routine = { ...demo.routines[0], name: 'Auto', nodes: [
    { id: 'step', type: 'function', invocation: { commandId: 'intake', arguments: {} } },
    { id: 'gen', type: 'generatedTrajectory', generatorId: 'g', arguments: {}, fallback: { type: 'branch', nodes: [{ id: 'fallback', type: 'function', invocation: { commandId: 'shoot', arguments: {} } }] } },
  ] };
  return { ...demo, robot: { ...demo.robot, id: 'robot' }, routines: [routine], activeRoutineId: routine.id };
}
const rows = (openUse) => {
  const html = renderToStaticMarkup(React.createElement(CommandPowerSummary, { power: { project: project(), robotId: 'robot', robotName: 'Robot', openUse,
    commands: [{ id: 'intake', label: 'Intake' }, { id: 'shoot', label: 'Shoot' }] } }));
  return [...html.matchAll(/<button[^>]*class="cmd-power-row"[^>]*>/g)].map((match) => match[0]);
};

describe('command use rows', () => {
  it('opens an editable use and disables a saved-fallback use, saying why', () => {
    const [editable, fallback] = rows(vi.fn());
    expect(editable).not.toMatch(/disabled/);
    expect(fallback).toMatch(/disabled=""/);
    expect(fallback).toMatch(/title="[^"]*fallback[^"]*"/i);
  });
});

describe('the 256-robot estimate cap on one use', () => {
  const full = (commandId = 'intake') => ({ commandId, arguments: {},
    power: Object.fromEntries(Array.from({ length: 256 }, (_, i) => ['robot_old' + i, { currentA: 1, inputKey: commandInputKey({ commandId, arguments: {} }) }])) });

  it('refuses a new robot on a full use in the inspector, and says why', () => {
    const p = createDemoProject();
    const html = renderToStaticMarkup(React.createElement(CommandPowerEditor, { invocation: full(), onInvocation: vi.fn(), power: { project: p, robotId: 'robot', robotName: 'Comp bot', robots: [] } }));
    expect(html).toContain('This command use already holds estimates for 256 robots');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Add power estimate/);
  });

  it('enforces it in the one write path Add, Copy and migration share, while an existing estimate can still change', () => {
    const invocation = full();
    expect(storeCommandEstimate(invocation, 'robot', { currentA: 5, inputKey: 'k' })).toBe(invocation);
    expect(commandEstimateCapProblem(invocation, 'robot')).toMatch(/already holds estimates for 256 robots/);
    expect(commandEstimateCapProblem(invocation, 'robot_old3')).toBeNull();
    expect(storeCommandEstimate(invocation, 'robot_old3', { currentA: 5, inputKey: 'k' }).power.robot_old3.currentA).toBe(5);
    // The project-wide writers refuse the full use and leave the others.
    let project = createDemoProject();
    const path = project.paths[0];
    project = { ...project, paths: [{ ...path, markers: [{ id: 'm0', f: 0.2, name: 'm0', invocation }, { id: 'm1', f: 0.4, name: 'm1', invocation: { commandId: 'intake', arguments: {} } }] }, ...project.paths.slice(1)] };
    const at = (markerIndex) => ({ kind: 'pathEvent', pathId: path.id, markerIndex, markerId: 'm' + markerIndex });
    expect(setCommandUseEstimate(project, at(0), 'robot', { currentA: 5 })).toBe(project);
    const withSecond = setCommandUseEstimate(project, at(1), 'robot', { currentA: 7 });
    expect(withSecond.paths[0].markers[1].invocation.power.robot.currentA).toBe(7);
    expect(copyCommandUseEstimate(withSecond, at(1), [at(0)], 'robot').paths[0].markers[0].invocation).toBe(invocation);
    const legacy = { ...project, robot: { ...project.robot, driveModel: { ...project.robot.driveModel, commandLoads: [{ commandId: 'intake', currentA: 30 }] } } };
    const migrated = migrateLegacyCommandLoads(legacy, 'robot');
    expect(migrated.paths[0].markers[0].invocation).toBe(invocation);
    expect(migrated.paths[0].markers[1].invocation.power.robot.currentA).toBe(30);
  });
});
