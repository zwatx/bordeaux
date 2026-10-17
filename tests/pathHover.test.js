import { describe, expect, it, vi } from 'vitest';
import { displayedPoseAtTime, hoverVisits, hoverWorldPoint } from '../src/renderer/lib/pathHover';
import { PM } from '../src/renderer/lib/pathMath';
import { editingPoseAtTime } from '../src/renderer/assets/editing-planning';
import { buildTimeline, tAtF } from '../src/renderer/components/pathTimelineModel';

const point = (f, distance = .01) => ({ f, distance });
describe('field hover visits and coordinates', () => {
  it('retains the selected fourth pass and remaps primary chronologically', () => {
    const candidates = [.1,.3,.5,.7].map(f => point(f));
    const focus = { candidates, index: 3, anchor: { x: 1, y: 1 } };
    expect(hoverVisits(candidates, { x: 1, y: 1 }, .1, focus)).toEqual({ f: [.1,.3,.7], primary: 2 });
    const changed = [point(.3), point(.7,.02)];
    expect(hoverVisits(changed, { x: 1, y: 1 }, .1, focus)).toEqual({ f: [.3,.7], primary: 1 });
    expect(hoverVisits(changed, { x: 2, y: 1 }, .1, focus)).toEqual({ f: [.3,.7], primary: 0 });
    expect(hoverVisits([point(.2,.05),point(.8,.01)], { x: 1, y: 1 }, .1, focus).primary).toBe(1);
  });
  it('rejects the nearestVisits fallback outside the real tolerance', () => {
    const pts = [{ x: 0, y: 0, s: 0 }, { x: 0, y: 3, s: 3 }];
    const world = { x: -10, y: 1 };
    const candidates = PM.nearestVisits(world.x, world.y, pts, { tolerance: .1 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(hoverVisits(candidates, world, .1, null)).toBeNull();
    const close = { x: -.05, y: 1 };
    expect(hoverVisits(PM.nearestVisits(close.x,close.y,pts,{ tolerance:.1 }),close,.1,null).f[0]).toBeCloseTo(1/3);
  });
  it('requests unbounded current conversion and rejects unavailable/noninvertible matrices', () => {
    const matrix = { a: 2, b: 0, c: 0, d: 2, e: 100, f: -40 };
    const svg = { getScreenCTM: () => ({ inverse: () => matrix }) };
    const convert = vi.fn((x,y,bounded) => ({ x: bounded ? 0 : (x - 100)/2, y: (y + 40)/2 }));
    expect(hoverWorldPoint(svg, -100, 20, convert)).toEqual({ x: -100, y: 30 });
    expect(convert).toHaveBeenLastCalledWith(-100,20,false);
    expect(hoverWorldPoint(null,0,0,convert)).toBeNull();
    expect(hoverWorldPoint({ getScreenCTM: () => null },0,0,convert)).toBeNull();
    expect(hoverWorldPoint({ getScreenCTM: () => ({ inverse() { throw Error('singular'); } }) },0,0,convert)).toBeNull();
    expect(hoverWorldPoint({ getScreenCTM: () => ({ inverse: () => ({...matrix,a:NaN}) }) },0,0,convert)).toBeNull();
    expect(hoverWorldPoint(svg,0,0,() => ({x:NaN,y:0}))).toBeNull();
  });
});

describe('shared displayed playback pose', () => {
  const doc = { waypoints: [{x:0,y:0,theta:90}] };
  const pts = [{x:0,y:0,s:0,heading:0},{x:2,y:0,s:2,heading:0}];
  const base = { sample: {pts}, mode:'tank',rev:false,anchors:[],prof:{t:[0,6],v:[0,0],totalTime:6,
    holds:[{idx:0,t0:0,t1:1,heading:0}], turns:[{idx:0,t0:1,t1:2,start:0,delta:Math.PI/2}],
    jiggles:[{idx:0,t0:2,t1:3,baseRad:0,tank:false,strokeDuration:1,config:{strokes:1,distanceM:.2,startDeg:0,stepDeg:0}}] } };
  it.each([false,true])('uses profile playback verbatim for normal/accepted/comparison fallback, reverse=%s', rev => {
    const derived = {...base,rev,acceptedTrajectory:true,finalTrajectory:{samples:[{t:0,x:99},{t:6,x:99}]}};
    for(const t of [0,.5,1,1.5,2,2.25,2.75,3,5,6]) {
      expect(displayedPoseAtTime(t,derived,doc)).toEqual(PM.poseAtTime(t,pts,derived.prof,derived.anchors,derived.mode,rev));
    }
    expect(displayedPoseAtTime(2.25,derived,doc).jiggle).toBe(true);
    expect(displayedPoseAtTime(1.5,derived,doc).turn).toBe(true);
    expect(displayedPoseAtTime(.5,derived,doc).hold).toBe(true);
  });
  it('prefers exact trace including stationary heading, excursion and reverse heading; first-arrival maps holds once', () => {
    const samples = [{t:0,f:0,x:0,y:0,headingRad:Math.PI,velocityMps:0},
      {t:1,f:.5,x:1,y:0,headingRad:Math.PI,velocityMps:0},
      {t:2,f:.5,x:1,y:0,headingRad:Math.PI*1.5,velocityMps:0},
      {t:3,f:.5,x:1.2,y:0,headingRad:Math.PI*1.5,velocityMps:.3},
      {t:4,f:1,x:2,y:0,headingRad:Math.PI*1.5,velocityMps:0}];
    const derived={...base,rev:true,trajectorySamples:samples};
    for(const t of [0,.5,1,1.5,2,2.5,3,3.5,4]) expect(displayedPoseAtTime(t,derived,doc)).toEqual(editingPoseAtTime(t,samples));
    expect(tAtF(buildTimeline(derived),.5)).toBe(1);
  });
  it('preserves first-waypoint and empty fallback', () => {
    const derived={...base,sample:{pts:[]},rev:true};
    expect(displayedPoseAtTime(0,derived,doc)).toMatchObject({x:0,y:0,heading:Math.PI*1.5});
    expect(displayedPoseAtTime(0,derived,{waypoints:[]})).toBeNull();
  });
});
