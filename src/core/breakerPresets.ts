import type { BreakerModel } from './types';

/** REV-11-1860-1863-DS-01: at 200%, min 5 s / typical 18 s / max 60 s.
 * Fit the earliest published cold trip point. Other overloads and warm starts remain estimates.
 * https://www.revrobotics.com/content/docs/REV-11-1860-1863-DS.pdf
 */
export const REV_40A_ATO_BREAKER: BreakerModel = { ratedCurrentA: 40, tripTimeAt2xS: 5, initialHeat: 0 };

/** Cooper Bussmann Series 18X catalog, revision 01.31.20, page 71.
 * 185120F: 185 switchable/manual reset, 120 A, surface mount.
 * Earliest edge at 200% is approximately 10 s, read from the plotted band (not a tabulated guarantee).
 * https://assets-fe147638ed.cdn.insitecloud.net/d978273f2b8897b/46960.pdf
 */
export const BUSSMANN_185_120A_BREAKER: BreakerModel = { ratedCurrentA: 120, tripTimeAt2xS: 10, initialHeat: 0 };
