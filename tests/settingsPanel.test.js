import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Panels } from '../src/renderer/components/Panels';
import { ProjectChip } from '../src/renderer/components/ProjectChip';
import { RobotPage } from '../src/renderer/components/RobotPage';
import { createDemoProject } from '../src/shared/project/defaults';

describe('settings workspace', () => {
  it('reads project, places, actions and Push left to right, with plain-text places', () => {
    const project = React.createElement(ProjectChip, { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', status: 'saved', robotCode: { status: 'unlinked' }, actions: {} });
    const push = React.createElement('div', { className: 'push-control' }, 'Push path');
    const markup = renderToStaticMarkup(React.createElement(Panels.Toolbar, { page: 'plan', project, push }));
    // The project is a name over one status line; its menu holds project commands.
    expect(markup).toContain('<span class="project-chip-name">Week 3 autos</span>');
    expect(markup).toMatch(/<span class="project-chip-meta"><span class="project-chip-status">Saved<\/span><\/span>/);
    // Places are text buttons with no icons; the current one carries aria-current.
    expect(markup).toContain('<nav class="places" aria-label="Project sections"><button type="button" class="place" aria-current="page">Paths</button><button type="button" class="place">Routines</button><button type="button" class="place">Settings</button></nav>');
    const order = ['tb-project', 'places', 'tb-actions', 'tb-push', 'keyboard-help-trigger'].map((name) => markup.indexOf(name));
    expect(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]))).toBe(true);
    expect(markup).not.toMatch(/pageswitch|Editor<|Flip/);
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('Optimize');
    expect(markup).not.toMatch(/Connect robot|Display units|Export JSON/);
  });

  it.each([
    [null, null], [{ phase: 'upToDate', version: null }, null], [{ phase: 'checking', version: null }, null],
    [{ phase: 'available', version: '0.3.0' }, 'Update available'],
    [{ phase: 'downloading', version: '0.3.0', progress: { percent: 41.6 } }, 'Downloading 42%'],
    [{ phase: 'downloaded', version: '0.3.0' }, 'Restart to update'],
    [{ phase: 'error', version: '0.3.0', errorStage: 'download' }, 'Update failed'],
  ])('shows update status quietly in the toolbar: %j', (updateState, label) => {
    const markup = renderToStaticMarkup(React.createElement(Panels.Toolbar, { page: 'plan', updateState }));
    expect(markup.includes('update-chip')).toBe(Boolean(label));
    if (label) expect(markup).toContain('</span>' + label + '</button>');
  });

  it.each([
    [{ pairing: null, busy: false, connectionLabel: 'Connect robot' }, 'Set up'],
    [{ pairing: { teamNumber: 2468 }, busy: false, connectionLabel: 'Team 2468' }, 'Edit'],
    [{ pairing: { teamNumber: 2468 }, busy: true, connectionLabel: 'Awaiting robot' }, 'Show progress'],
  ])('keeps connection and units available with the robot configuration', (pushController, label) => {
    const markup = renderToStaticMarkup(React.createElement(RobotPage, {
      robot: createDemoProject().robot, unitSystem: 'imperial', pushController,
    }));
    expect(markup).toContain(label);
    expect(markup).toContain('aria-label="Display units"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Imperial/);
    expect(markup).toContain('Drivetrain');
    expect(markup).not.toContain('<dialog');
  });
});
