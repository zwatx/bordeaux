import { describe, expect, it } from "vitest";
import { indexIntervalPolicies, indexPointPolicies, type IntervalPolicy } from "../src/core/planners/intervalPolicies";
// @ts-expect-error The renderer math module is intentionally JavaScript.
import { PM } from "../src/renderer/lib/pathMath";

const EPSILON = 1e-9;
const LIMIT_KEYS = ["maxVel", "maxAccel", "maxDecel", "maxAngVel", "maxAngAccel"] as const;
const RESULT_KEYS = [...LIMIT_KEYS, "activeTranslationPriority", "translationPriority"] as const;

function naiveIndex(fractions: number[], ranges: IntervalPolicy[], transitions: IntervalPolicy[]) {
  const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [key, new Array(fractions.length).fill(Infinity)]));
  const translationPriority = new Array(fractions.length).fill(false);
  const activeTranslationPriority = new Array(fractions.length).fill(false);
  let transitionFollowing = false;
  for (let index = 1; index < fractions.length; index += 1) {
    const start = Math.min(fractions[index - 1], fractions[index]);
    const end = Math.max(fractions[index - 1], fractions[index]);
    const overlaps = (policy: IntervalPolicy) => (
      Math.min(end, Math.max(policy.start, policy.end)) - Math.max(start, Math.min(policy.start, policy.end)) >= -EPSILON
    );
    const activeRanges = ranges.filter(overlaps);
    const activeTransitions = transitions.filter(overlaps);
    LIMIT_KEYS.forEach((key) => {
      activeRanges.forEach((range) => {
        const value = range[key];
        if (typeof value === "number" && value > 0) limits[key][index] = Math.min(limits[key][index], value);
      });
    });
    if (activeTransitions.length > 0) {
      transitionFollowing = activeTransitions.every((policy) => policy.rotationPriority === "translation");
    }
    const activePolicies = [...activeRanges, ...activeTransitions];
    activeTranslationPriority[index] = activePolicies.length > 0
      && activePolicies.every((policy) => policy.rotationPriority === "translation");
    translationPriority[index] = activePolicies.length > 0
      ? activeTranslationPriority[index]
      : transitionFollowing;
  }
  return { ...limits, activeTranslationPriority, translationPriority };
}

function plain(result: ReturnType<typeof indexIntervalPolicies>) {
  return Object.fromEntries(RESULT_KEYS.map((key) => [key, [...result[key]]]));
}

describe("constraint range interval index", () => {
  it("matches the prior inclusive scan at narrow, reversed, and shared boundaries", () => {
    const fractions = [0, 0.1, 0.25, 0.25, 0.6, 1];
    const ranges: IntervalPolicy[] = [
      { start: 0.12, end: 0.13, maxVel: 0.2, maxAccel: 0.3, rotationPriority: "translation" },
      { start: 0.7, end: 0.3, maxVel: 1.4, maxDecel: 0.5, maxAngVel: 80, rotationPriority: "heading" },
      { start: 0.25, end: 0.25, maxVel: 0.1, maxAngAccel: 40, rotationPriority: "translation" },
      { start: 1.1, end: 1.2, maxVel: 0.01, rotationPriority: "translation" },
    ];
    const transitions: IntervalPolicy[] = [
      { start: 0.02, end: 0.04, rotationPriority: "translation" },
      { start: 0.24, end: 0.3, rotationPriority: "heading" },
      { start: 0.55, end: 0.56, rotationPriority: "translation" },
    ];

    expect(plain(indexIntervalPolicies(fractions, ranges, transitions)))
      .toEqual(naiveIndex(fractions, ranges, transitions));
    const transitionOnly = indexIntervalPolicies(
      [0, 0.2, 0.4, 0.6, 1],
      [],
      [{ start: 0.21, end: 0.22, rotationPriority: "translation" }],
    );
    expect(transitionOnly.activeTranslationPriority.at(-1)).toBe(false);
    expect(transitionOnly.translationPriority.at(-1)).toBe(true);
    const points = indexPointPolicies(fractions, ranges);
    fractions.forEach((fraction, index) => {
      const active = ranges.filter((range) => (
        fraction >= Math.min(range.start, range.end) - EPSILON
        && fraction <= Math.max(range.start, range.end) + EPSILON
      ));
      (["maxVel", "maxAccel", "maxDecel"] as const).forEach((key) => {
        const values = active.map((range) => range[key]).filter((value): value is number => typeof value === "number" && value > 0);
        expect(points[key][index]).toBe(values.length > 0 ? Math.min(...values) : Infinity);
      });
    });
  });

  it("keeps the renderer mirror in exact policy parity", () => {
    const fractions = Array.from({ length: 65 }, (_, index) => index / 64);
    const ranges = Array.from({ length: 40 }, (_, index): IntervalPolicy => ({
      start: ((index * 17) % 97) / 97,
      end: ((index * 17) % 97) / 97 + (index % 3 === 0 ? 0.001 : 0.08),
      maxVel: 0.4 + index % 7,
      maxAccel: index % 5 === 0 ? 0 : 0.2 + index % 4,
      maxDecel: 0.3 + index % 6,
      maxAngVel: 45 + index,
      maxAngAccel: 90 + index * 2,
      rotationPriority: index % 4 === 0 ? "translation" : "heading",
    }));
    const transitions: IntervalPolicy[] = [
      { start: 0.11, end: 0.111, rotationPriority: "translation" },
      { start: 0.48, end: 0.52, rotationPriority: "heading" },
      { start: 0.81, end: 0.811, rotationPriority: "translation" },
    ];
    const renderer = PM;

    const shared = plain(indexIntervalPolicies(fractions, ranges, transitions));
    expect(shared).toEqual(naiveIndex(fractions, ranges, transitions));
    expect(plain(renderer.indexIntervalPolicies(fractions, ranges, transitions))).toEqual(shared);
  });
});
