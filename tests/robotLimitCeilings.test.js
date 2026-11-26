import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultRobot } from '../src/core/project/defaults';
import { effectivePathConstraints, robotHardLimits, robotLimitCeilings } from '../src/core/robotLimits';
import { UI } from '../src/renderer/components/ui';
import { UnitPrefs } from '../src/renderer/lib/unitPreferences';

/*
 * A path or zone limit above what the robot can do, written before the code. Failure modes:
 *  1. The ceiling shown differs from the limit planning uses.
 *  2. A robot without a drivetrain model reports ceilings it does not enforce.
 *  3. A field at or under the ceiling is marked, or one over it is not.
 *  4. The mark is colour only: no text for hover or a screen reader.
 *  5. The note shows metric numbers while the field shows imperial ones.
 *  6. A field given no ceiling is marked.
 */
// Synthetic drivetrain values, not a real robot.
const model = (gearRatio) => ({ motorId: 'custom', motorFreeRpm: 6000, motorMaxTorqueNm: 4, motorCount: 4, gearRatio, wheelDiameterM: 0.1016,
  massKg: 50, moiKgM2: 5, wheelbaseM: 0.6, trackwidthM: 0.6, wheelFrictionCoefficient: 1.2 });
const high = { maxVel: 50, maxAccel: 500, maxDecel: 500, maxCentripetalAccel: 500, maxAngVel: 50000, maxAngAccel: 500000, maxAngDecel: 500000 };
const field = (props) => renderToStaticMarkup(React.createElement(UI.Num, { label: 'Speed', unit: 'm/s', ceilingName: 'speed', onChange: () => {}, ...props }));

describe('robot limit ceilings', () => {
  afterEach(() => UnitPrefs.set('metric'));

  it('are exactly the limits planning applies to a path set far above them', () => {
    const robot = { ...defaultRobot(), driveModel: model(16) };
    const ceilings = robotLimitCeilings(robot), planned = effectivePathConstraints(high, robot);
    expect(ceilings.maxVel).toBe(robotHardLimits(robot).maxSpeedMps);
    for (const key of ['maxVel', 'maxAccel', 'maxDecel', 'maxCentripetalAccel', 'maxAngVel', 'maxAngAccel']) expect(ceilings[key], key).toBe(planned[key]);
    expect(ceilings.maxVel).toBeLessThan(2.1);
  });

  it('are only the top speed for a robot without a drivetrain model', () => {
    const robot = defaultRobot();
    expect(robotLimitCeilings(robot)).toEqual({ maxVel: robot.maxSpeed });
    expect(effectivePathConstraints(high, robot)).toBe(high);
  });

  it('mark a field over its ceiling with a reason for hover and screen readers', () => {
    const over = field({ value: 5, ceiling: 1.995 });
    expect(over).toMatch(/class="numbox capped" title="Your robot’s max speed is 2\.00 m\/s"/);
    expect(over).toMatch(/<span id="[^"]+-cap" class="sr-only">Your robot’s max speed is 2\.00 m\/s<\/span>/);
    expect(over).toMatch(/aria-describedby="[^"]*-cap"/);
    expect(over).toContain('value="5.00"');
  });

  it.each([[1.995, 1.995], [1.5, 1.995], [5, undefined], [5, null]])('leave a field of %s with ceiling %s unmarked', (value, ceiling) => {
    const markup = field({ value, ceiling });
    expect(markup).not.toContain('capped');
    expect(markup).not.toContain('Your robot');
  });

  it('state the ceiling in the units the field shows', () => {
    UnitPrefs.set('imperial');
    expect(field({ value: 5, ceiling: 1.995 })).toContain('title="Your robot’s max speed is 6.55 ft/s"');
  });
});
