import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Panels } from '../src/renderer/components/Panels';
import { ProjectChip } from '../src/renderer/components/ProjectChip';
import { RobotPage } from '../src/renderer/components/RobotPage';
import { AppSettings } from '../src/renderer/components/AppSettings';
import { createDemoProject } from '../src/core/project/defaults';

describe('settings workspace', () => {
  it('reads project, places, actions and Push left to right, with plain-text places', () => {
    const project = React.createElement(ProjectChip, { name: 'Week 3 autos', folderPath: '/team/Week 3 autos', status: 'saved', robotCode: { status: 'unlinked' }, actions: {} });
    const push = React.createElement('div', { className: 'push-control' }, 'Push path');
    const appSettings = React.createElement('button', { className: 'app-settings-trigger' });
    const markup = renderToStaticMarkup(React.createElement(Panels.Toolbar, { page: 'plan', project, push, appSettings }));
    // Saved projects show only their name; the menu holds project commands.
    expect(markup).toContain('<span class="project-chip-name">Week 3 autos</span>');
    expect(markup).not.toContain('project-chip-status');
    // Places are text buttons with no icons; the current one carries aria-current.
    expect(markup).toContain('<nav class="places" style="--place-index:0" aria-label="Project sections"><button type="button" class="place" aria-current="page">Paths</button><button type="button" class="place">Routines</button><button type="button" class="place">Robot</button></nav>');
    const order = ['tb-project', 'places', 'tb-actions', 'tb-push', 'app-settings-trigger', 'keyboard-help-trigger'].map((name) => markup.indexOf(name));
    expect(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]))).toBe(true);
    expect(markup).not.toMatch(/pageswitch|Editor<|Flip/);
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('Optimize');
    expect(markup).not.toMatch(/Connect robot|Display units|Export JSON/);
  });

  it.each([
    [null, null, null], [{ phase: 'unsupported', version: null }, null, null],
    [{ phase: 'idle', version: null }, 'idle', 'Check for updates'], [{ phase: 'upToDate', version: null }, 'idle', 'Check for updates'],
    [{ phase: 'checking', version: null }, 'idle checking', 'Checking for updates…'],
    [{ phase: 'available', version: '0.3.0' }, 'available', 'Update 0.3.0 ready to download'],
    [{ phase: 'downloading', version: '0.3.0', progress: { percent: 41.6 } }, 'downloading', 'Downloading update (41%)'],
    [{ phase: 'downloaded', version: '0.3.0' }, 'ready', 'Update 0.3.0 downloaded. Click to restart and install.'],
    [{ phase: 'error', version: '0.3.0', errorStage: 'download' }, 'available failed', 'Download failed for 0.3.0. Click for details.'],
    [{ phase: 'error', version: '0.3.0', errorStage: 'install' }, 'ready failed', 'Install failed for 0.3.0. Click to retry.'],
    [{ phase: 'installing', version: '0.3.0', installStalled: true }, 'ready failed', 'Restart delayed. Click for options.'],
  ])('shows update status as one toolbar icon: %j', (updateState, kind, label) => {
    const markup = renderToStaticMarkup(React.createElement(Panels.Toolbar, { page: 'plan', updateState }));
    expect(markup.includes('update-button')).toBe(Boolean(kind));
    if (kind) expect(markup).toContain(`class="update-button ${kind}" title="${label}" aria-label="${label}"`);
  });

  it.each([
    [{ pairing: null, busy: false, connectionLabel: 'Connect robot' }, 'Set up'],
    [{ pairing: { teamNumber: 2468 }, busy: false, connectionLabel: 'Team 2468' }, 'Edit'],
    [{ pairing: { teamNumber: 2468 }, busy: true, connectionLabel: 'Awaiting robot' }, 'Show progress'],
  ])('keeps connection and units in global settings, apart from the robot configuration', (connection, label) => {
    const markup = renderToStaticMarkup(React.createElement(AppSettings, { unitSystem: 'imperial', connection }));
    expect(markup).toContain('aria-label="Global settings"');
    expect(markup).toContain('>Global settings</h2>');
    expect(markup).toContain(label);
    expect(markup).toContain('aria-label="Display units"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Imperial/);
    expect(markup).not.toContain('Drivetrain');
    const robot = renderToStaticMarkup(React.createElement(RobotPage, { robot: createDemoProject().robot, unitSystem: 'imperial' }));
    expect(robot).toContain('<h1 class="rp-title">Robot</h1>');
    expect(robot).toContain('Drivetrain');
    expect(robot).not.toMatch(/Display units|Robot connection|Keyboard shortcuts|Software updates/);
  });
});
