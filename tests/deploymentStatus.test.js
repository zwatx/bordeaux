import { describe, expect, it } from 'vitest';
import { createDemoProject, blankPath } from '../src/core/project/defaults';
import { deploymentInputKey, deploymentItemStatus } from '../src/renderer/lib/deploymentStatus';

describe('verified library comparison invalidation', () => {
  it('ignores folders, editor state, display units, and planning notes but invalidates motion edits', () => {
    const project = createDemoProject(); const id = project.paths[0].id;
    const key = deploymentInputKey(project, 'path', id, 'catalog');
    project.paths[0].folderId = 'folder'; project.editor = { activePathId: 'another', unitSystem: 'imperial' };
    project.robot.planning = { ...project.robot.planning, notes: 'Pit note' };
    expect(deploymentInputKey(project, 'path', id, 'catalog')).toBe(key);
    project.paths[0].constraints.maxVel *= 0.8;
    expect(deploymentInputKey(project, 'path', id, 'catalog')).not.toBe(key);
    expect(deploymentInputKey(project, 'path', id, 'other-catalog')).not.toBe(key);
  });
  it('includes branch, fallback and linked path changes in routine invalidation', () => {
    const project = createDemoProject(); project.paths = ['A', 'B', 'C'].map((id) => ({ ...blankPath(id), id }));
    project.routines = [{ id: 'R', name: 'Routine', nodes: [{ id: 'decision', type: 'decision', cond: 'sensor', thenLabel: 'yes', elseLabel: 'no', then: [{ id: 'a', type: 'path', ref: 'A' }], else: [{ id: 'gen', type: 'generatedTrajectory', generatorId: 'g', arguments: {}, fallback: { type: 'branch', nodes: [{ id: 'b', type: 'path', ref: 'B' }] } }] }] }];
    project.pathLinks = [{ id: 'link', fromPathId: 'B', toPathId: 'C' }];
    const key = deploymentInputKey(project, 'routine', 'R', 'catalog');
    project.paths[2].constraints.maxVel *= 0.8;
    expect(deploymentInputKey(project, 'routine', 'R', 'catalog')).not.toBe(key);
  });
  it('never treats unknown, stale, or changed inputs as a match', () => {
    const now = Date.now(), verifiedAt = new Date(now).toISOString();
    const matches = { state: 'matches' };
    expect(deploymentItemStatus(matches, 'a', 'a', verifiedAt, now).label).toBe('Matches robot');
    expect(deploymentItemStatus(matches, 'a', 'b', verifiedAt, now).label).toBe('Changed');
    expect(deploymentItemStatus(matches, 'a', 'a', verifiedAt, now + 60_001).label).toBe('Unknown');
    expect(deploymentItemStatus(null, 'a', 'a', verifiedAt, now).label).toBe('Unknown');
  });
});
