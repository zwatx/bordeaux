import { describe, expect, it } from 'vitest';
import { placeProblemBadges, placeFieldLabel, problemBadgeIndexes, problemBoxesOverlap, problemCaption } from '../src/renderer/components/fieldProblems';
const problems = Array.from({ length: 20 }, (_, i) => ({ code: 'linear-acceleration', severity: i % 4 === 0 ? 'note' : 'error', f0: i/30, f1: (i+1)/30 }));
describe('field problem placement and original indices', () => {
  it('skips notes without renumbering and includes a chosen problem beyond the cap', () => {
    const base = problemBadgeIndexes(problems, null), chosen = problemBadgeIndexes(problems, 19);
    expect(base).toHaveLength(12); expect(base[0]).toBe(1);
    expect(chosen).toHaveLength(12); expect(chosen.at(-1)).toBe(19);
    expect(chosen.slice(0, -1)).toEqual(base.slice(0, -1));
    expect(problemBadgeIndexes(problems, 0)).toEqual(base);
    expect(problemBadgeIndexes(problems, 19, 0)).toEqual([]);
    expect(problemBadgeIndexes([], 2)).toEqual([]);
    expect(problemBadgeIndexes(problems, 999)).toEqual(base);
  });
  it('uses span midpoints, flips around existing obstacles, and shares exact hit boxes', () => {
    const issues = [{f0:.1,f1:.3},{f0:.1,f1:.3}];
    const fractions = [];
    const obstacles = [{ x: 70, y: 56, w: 60, h: 32 }];
    const badges = placeProblemBadges(issues, [0,1], f => { fractions.push(f); return {x:100,y:100}; }, {x:0,y:0,w:400,h:300}, 1, obstacles);
    expect(fractions).toEqual([.2,.2]); expect(badges[0].y).toBe(128);
    expect(problemBoxesOverlap(badges[0].box, obstacles[0])).toBe(false);
    expect(problemBoxesOverlap(badges[0].box, badges[1].box)).toBe(false);
    expect(badges[1].index).toBe(1);
  });
  it('places selected captions clear of co-located badges and existing zone labels', () => {
    const issues=Array.from({length:5},()=>({code:'linear-acceleration',f0:.5,f1:.5}));
    const bounds={x:0,y:0,w:400,h:300};
    const badges=placeProblemBadges(issues,[0,1,2,3,4],()=>({x:100,y:100}),bounds,1);
    const zone={x:0,y:128,w:200,h:24};
    const caption=problemCaption(issues[0],3,badges[0],bounds,1,[...badges.map(b=>b.box),zone]);
    for(const box of [...badges.map(b=>b.box),zone])expect(problemBoxesOverlap(caption,box)).toBe(false);
  });
  it('clamps the entire visit label in a panned viewport and flips below occupied space', () => {
    const bounds={x:1000,y:200,w:400,h:300};
    const occupied={x:1100,y:240,w:160,h:26};
    const below=placeFieldLabel({x:1100,y:270},100,16,bounds,1,[occupied],false);
    expect(problemBoxesOverlap(below,occupied)).toBe(false);expect(below.y).toBeGreaterThan(270);
    const edge=placeFieldLabel({x:1398,y:205},100,16,bounds,1,[],false);
    expect(edge.x).toBeGreaterThanOrEqual(1000);expect(edge.x+edge.w).toBeLessThanOrEqual(1400);
    expect(edge.y).toBeGreaterThanOrEqual(200);expect(edge.y+edge.h).toBeLessThanOrEqual(500);
  });
  it('clamps edge and whole-path badges and long captions inside the visible view', () => {
    const bounds={x:30,y:20,w:220,h:100};
    const [badge]=placeProblemBadges([{f0:0,f1:1}], [0], () => ({x:1000,y:-1000}), bounds, 1);
    expect(badge.box.x).toBeGreaterThanOrEqual(bounds.x); expect(badge.box.x+badge.box.w).toBeLessThanOrEqual(bounds.x+bounds.w);
    expect(badge.box.y).toBeGreaterThanOrEqual(bounds.y); expect(badge.box.y+badge.box.h).toBeLessThanOrEqual(bounds.y+bounds.h);
    const caption=problemCaption({code:'unknown',message:'A very long authored planner issue message at the edge',f0:0,f1:1}, 3, badge,bounds,1);
    expect(caption.x).toBeGreaterThanOrEqual(bounds.x); expect(caption.x+caption.width).toBeLessThanOrEqual(bounds.x+bounds.w);
  });
});
