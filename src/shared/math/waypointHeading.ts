import type { Waypoint } from "../types";

/** Heading-anchor membership and local constraints under the effective leg laws.
 * Pass tank-resolved laws; lookAt laws may include their target coordinates.
 * Endpoint theta anchors both interpolated laws even when thetaOn is false,
 * but only the active arrival law makes it a required arrival heading.
 */
export function waypointHeadingSemantics(waypoint: Waypoint, index: number, segmentLaws: readonly string[]) {
  const isEnd = index === 0 || index === segmentLaws.length;
  const incoming = segmentLaws[index - 1];
  const outgoing = segmentLaws[index];
  const anchors = (law: "manual" | "targets") => isEnd
    || Boolean(waypoint.thetaOn && (incoming === law || (waypoint.turnInPlace && outgoing === law)));
  const manual = anchors("manual"), targets = anchors("targets");
  const arrivalLaw = index === 0 ? outgoing : incoming;
  return {
    manual,
    targets,
    // An outgoing-only anchor at a turn does not constrain the incoming pose.
    arrival: (arrivalLaw === "manual" && manual) || (arrivalLaw === "targets" && targets),
    // Stored theta is a chassis heading, never a travel-handle constraint.
    // A visible turn must match its outgoing law; only tangent ties it to a handle.
    tangentDepartureDeg: outgoing === "tangent" ? waypoint.turnInPlace?.headingDeg : undefined,
  };
}
