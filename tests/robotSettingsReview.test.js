import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { RobotPage } from '../src/renderer/components/RobotPage';
import { UnitPrefs } from '../src/renderer/lib/unitPreferences';
import { createDemoProject } from '../src/core/project/defaults';

describe('robot settings page', () => {
  afterEach(() => UnitPrefs.set('metric'));

  it.each(['rev-neo', 'rev-vortex', 'ctre-kraken-x60', 'ctre-falcon-500', 'custom'])('locks only motor-provided specifications for %s', (motorId) => {
    const robot = createDemoProject().robot;
    robot.driveModel = { ...robot.driveModel, motorId, motorFreeRpm: 5676, motorMaxTorqueNm: 2.6 };
    const markup = renderToStaticMarkup(React.createElement(RobotPage, { robot }));
    for (const label of ['Motor free speed', 'Motor torque limit', 'Drive reduction', 'Wheel diameter', 'Drive motors', 'Mass']) {
      const input = markup.match(new RegExp(`<input(?=[^>]*aria-label="${label}")[^>]*>`))[0];
      expect(input.includes('disabled=""')).toBe(motorId !== 'custom' && ['Motor free speed', 'Motor torque limit'].includes(label));
    }
  });

  it.each([
    ['metric', '0.254', 'm'],
    ['imperial', '10.000', 'in'],
  ])('shows custom footprint coordinates in %s units', (system, display, unit) => {
    UnitPrefs.set(system);
    const robot = createDemoProject().robot;
    robot.footprintPreset = { kind: 'custom' };
    robot.footprint = { kind: 'polygon', verticesM: [
      { x: 0.254, y: -0.254 }, { x: 0.254, y: 0.254 },
      { x: -0.254, y: 0.254 }, { x: -0.254, y: -0.254 },
    ] };
    const before = structuredClone(robot);
    const markup = renderToStaticMarkup(React.createElement(RobotPage, {
      robot, unitSystem: system,
    }));
    expect(markup).toMatch(new RegExp(`<input(?=[^>]*aria-label="Vertex 1 X")(?=[^>]*step="0[.]01")(?=[^>]*value="${display.replace(".", "[.]")}")[^>]*><span class="u">${unit}</span>`));
    expect(markup).toMatch(new RegExp(`<input(?=[^>]*aria-label="Vertex 1 Y")(?=[^>]*step="0[.]01")(?=[^>]*value="-${display.replace(".", "[.]")}")[^>]*><span class="u">${unit}</span>`));
    expect(robot).toEqual(before);
  });
});
