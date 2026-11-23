import { FIELD_H, FIELD_W } from "../math/fieldBounds";
import {
  appToAllianceViewPoint,
  appToOfficialPoint,
  officialToAppPoint,
  REBUILT_2026_CROSSINGS,
  REBUILT_2026_FIELD,
  REBUILT_2026_FIELD_LENGTH_M,
  REBUILT_2026_FIELD_WIDTH_M,
  REBUILT_2026_INITIAL_FUEL_REGION,
  REBUILT_2026_NEUTRAL_ZONE,
  REBUILT_2026_TRENCH_CLEARANCE_M,
} from "./rebuilt2026";
import type { ProjectStrategyOverlay } from "../types";
import type { FieldPoint, ResolveFieldTermOptions, ResolvedFieldTerm } from "./types";

function normalized(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
}

export function resolveStrategyTerm(rawPhrase: string, strategy?: ProjectStrategyOverlay): ResolvedFieldTerm | null {
  const phrase = normalized(rawPhrase);
  const matches = (strategy?.locations ?? []).filter((location) => [location.name, ...(location.aliases ?? [])].some((term) => normalized(term) === phrase)).map((location) => {
    const point = location.kind === "pose" ? { x: location.x, y: location.y } : {
      x: (location.bounds.xMin + location.bounds.xMax) / 2,
      y: (location.bounds.yMin + location.bounds.yMax) / 2,
    };
    return {
      id: location.id,
      label: location.name,
      point,
      confidence: 1,
      reason: location.kind === "pose" ? "Exact team strategy pose." : "Center of the exact team strategy region.",
      ...(location.headingDeg === undefined ? {} : { headingDeg: location.headingDeg }),
    };
  });
  if (matches.length === 0) return null;
  return {
    phrase: rawPhrase,
    status: matches.length === 1 ? "resolved" : "ambiguous",
    matches,
    ...(matches.length === 1 ? {} : { message: `Team strategy term “${rawPhrase}” matches more than one location.` }),
  };
}

function relativePoint(direction: "front" | "back" | "left" | "right", options: ResolveFieldTermOptions): ResolvedFieldTerm {
  if (!options.pose) {
    return {
      phrase: direction,
      status: "unresolved",
      matches: [],
      message: `“${direction} of the bot” needs a specific robot pose or trajectory sample.`,
    };
  }
  if (!Number.isFinite(options.pose.x) || !Number.isFinite(options.pose.y) || options.pose.x < 0 || options.pose.x > FIELD_W || options.pose.y < 0 || options.pose.y > FIELD_H) {
    return { phrase: direction, status: "unresolved", matches: [], message: "Robot-relative vocabulary requires a finite pose inside the Bordeaux field bounds." };
  }
  const distance = Math.max(0.01, Math.min(5, options.relativeDistanceM ?? 0.5));
  const offset = direction === "front" ? 0
    : direction === "back" ? Math.PI
      : direction === "left" ? Math.PI / 2
        : -Math.PI / 2;
  const physicalHeadingRad = options.pose.headingSource === "physical"
    ? options.pose.physicalHeadingRad
    : options.pose.authoredHeadingRad + (options.pose.driveBackward ? Math.PI : 0);
  const angle = physicalHeadingRad + offset;
  const point = {
    x: options.pose.x + Math.cos(angle) * distance,
    y: options.pose.y + Math.sin(angle) * distance,
  };
  if (point.x < 0 || point.x > FIELD_W || point.y < 0 || point.y > FIELD_H) {
    return { phrase: direction, status: "unresolved", matches: [], message: `The requested point ${distance.toFixed(2)} m ${direction} of the robot is outside the field; Bordeaux will not shorten or clamp it.` };
  }
  return {
    phrase: direction,
    status: "resolved",
    matches: [{
      id: `robot-${direction}`,
      label: `${direction} of the robot`,
      point,
      confidence: 1,
      reason: `Resolved ${distance.toFixed(2)} m in the physical chassis ${direction} direction.`,
    }],
  };
}

function hasAny(phrase: string, values: string[]): boolean {
  return values.some((value) => phrase.includes(value));
}

function phraseAlliance(phrase: string): "blue" | "red" | undefined {
  const blue = /(?:^| )blue(?: |$)/.test(phrase);
  const red = /(?:^| )red(?: |$)/.test(phrase);
  return blue === red ? undefined : blue ? "blue" : "red";
}

function requestedAlliance(rawPhrase: string, phrase: string, options: ResolveFieldTermOptions): { alliance?: "blue" | "red"; error?: ResolvedFieldTerm } {
  const explicit = phraseAlliance(phrase);
  if (explicit && options.alliance && explicit !== options.alliance) {
    return { error: { phrase: rawPhrase, status: "unresolved", matches: [], message: `“${rawPhrase}” names the ${explicit} field structure but the request alliance is ${options.alliance}; Bordeaux will not silently substitute the opposite alliance.` } };
  }
  return { alliance: explicit ?? options.alliance ?? options.defaultAlliance };
}

export function withAllianceView(result: ResolvedFieldTerm, allianceView: "blue" | "red"): ResolvedFieldTerm {
  return { ...result, matches: result.matches.map((match) => ({ ...match, displayPoint: appToAllianceViewPoint(match.point, allianceView) })) };
}

function allianceOfficialPoint(alliance: "blue" | "red", bluePoint: FieldPoint): FieldPoint {
  return alliance === "blue" ? bluePoint : {
    x: REBUILT_2026_FIELD_LENGTH_M - bluePoint.x,
    // Near/far is longitudinal. Preserve the caller's physical guardrail lane;
    // rotating Y here silently moved red routes to the opposite side.
    y: bluePoint.y,
  };
}

function fieldMatch(id: string, label: string, officialPoint: FieldPoint, reason: string) {
  return { id, label, officialPoint, point: officialToAppPoint(officialPoint), confidence: 1, reason };
}

export function resolveFieldTerm(rawPhrase: string, options: ResolveFieldTermOptions = {}): ResolvedFieldTerm {
  const phrase = normalized(rawPhrase);
  const robotDirection = hasAny(phrase, ["front of bot", "front of robot", "in front of bot", "in front of robot", "ahead of bot", "ahead of robot"])
    ? "front"
    : hasAny(phrase, ["back of bot", "back of robot", "behind bot", "behind robot", "rear of bot", "rear of robot"])
      ? "back"
      : hasAny(phrase, ["left of bot", "left of robot", "bot left", "robot left"])
        ? "left"
        : hasAny(phrase, ["right of bot", "right of robot", "bot right", "robot right"])
          ? "right"
          : null;
  if (robotDirection) return { ...relativePoint(robotDirection, options), phrase: rawPhrase };

  if (phrase.includes("center line") || phrase === "midfield" || phrase === "middle of the field") {
    return {
      phrase: rawPhrase,
      status: "resolved",
      matches: [fieldMatch("center-line", "CENTER LINE", {
        x: REBUILT_2026_FIELD_LENGTH_M / 2,
        y: options.pose ? appToOfficialPoint(options.pose).y : REBUILT_2026_FIELD_WIDTH_M / 2,
      }, "Official CENTER LINE landmark, transformed into Bordeaux coordinates.")],
    };
  }

  const initialFuelBand = phrase.includes("fuel") && hasAny(phrase, ["band", "cloud", "staging", "starting", "initial"]);
  if (initialFuelBand && hasAny(phrase, ["far side", "far edge", "opposite side", "other side"])) {
    const requested = requestedAlliance(rawPhrase, phrase, options);
    if (requested.error) return requested.error;
    if (!requested.alliance) return { phrase: rawPhrase, status: "unresolved", matches: [], message: "The far side of the initial FUEL band needs an alliance context." };
    const bluePoint = { x: REBUILT_2026_INITIAL_FUEL_REGION.xMax, y: options.pose ? appToOfficialPoint(options.pose).y : REBUILT_2026_FIELD_WIDTH_M / 2 };
    const officialPoint = allianceOfficialPoint(requested.alliance, bluePoint);
    return {
      phrase: rawPhrase,
      status: "resolved",
      matches: [fieldMatch(`${requested.alliance}-initial-fuel-far-edge`, `Far edge of the initial FUEL band for ${requested.alliance}`, officialPoint, "Resolved to the far edge of the official approximately 72-inch-deep starting FUEL corral, not the far edge of the full NEUTRAL ZONE.")],
    };
  }

  if (initialFuelBand && hasAny(phrase, ["near side", "near edge", "our side"])) {
    const requested = requestedAlliance(rawPhrase, phrase, options);
    if (requested.error) return requested.error;
    if (!requested.alliance) return { phrase: rawPhrase, status: "unresolved", matches: [], message: "The near side of the initial FUEL band needs an alliance context." };
    const bluePoint = { x: REBUILT_2026_INITIAL_FUEL_REGION.xMin, y: options.pose ? appToOfficialPoint(options.pose).y : REBUILT_2026_FIELD_WIDTH_M / 2 };
    const officialPoint = allianceOfficialPoint(requested.alliance, bluePoint);
    return {
      phrase: rawPhrase,
      status: "resolved",
      matches: [fieldMatch(`${requested.alliance}-initial-fuel-near-edge`, `Near edge of the initial FUEL band for ${requested.alliance}`, officialPoint, "Resolved to the near edge of the official approximately 72-inch-deep starting FUEL corral.")],
    };
  }

  if (phrase.includes("neutral") && hasAny(phrase, ["far side", "far edge", "opposite side", "other side"])) {
    const requested = requestedAlliance(rawPhrase, phrase, options);
    if (requested.error) return requested.error;
    if (!requested.alliance) return { phrase: rawPhrase, status: "unresolved", matches: [], message: "The far side of the NEUTRAL ZONE needs an alliance context." };
    const bluePoint = { x: REBUILT_2026_NEUTRAL_ZONE.xMax, y: options.pose ? appToOfficialPoint(options.pose).y : REBUILT_2026_FIELD_WIDTH_M / 2 };
    const officialPoint = allianceOfficialPoint(requested.alliance, bluePoint);
    return {
      phrase: rawPhrase,
      status: "resolved",
      matches: [fieldMatch(`${requested.alliance}-neutral-far-edge`, `Far edge of the NEUTRAL ZONE for ${requested.alliance}`, officialPoint, "Resolved away from the selected alliance wall.")],
    };
  }

  if (phrase.includes("neutral") && hasAny(phrase, ["near side", "near edge", "our side"])) {
    const requested = requestedAlliance(rawPhrase, phrase, options);
    if (requested.error) return requested.error;
    if (!requested.alliance) return { phrase: rawPhrase, status: "unresolved", matches: [], message: "The near side of the NEUTRAL ZONE needs an alliance context." };
    const bluePoint = { x: REBUILT_2026_NEUTRAL_ZONE.xMin, y: options.pose ? appToOfficialPoint(options.pose).y : REBUILT_2026_FIELD_WIDTH_M / 2 };
    const officialPoint = allianceOfficialPoint(requested.alliance, bluePoint);
    return {
      phrase: rawPhrase,
      status: "resolved",
      matches: [fieldMatch(`${requested.alliance}-neutral-near-edge`, `Near edge of the NEUTRAL ZONE for ${requested.alliance}`, officialPoint, "Resolved toward the selected alliance wall.")],
    };
  }

  if (phrase.includes("trench") || phrase.includes("bump")) {
    const requested = requestedAlliance(rawPhrase, phrase, options);
    if (requested.error) return requested.error;
    if (!requested.alliance) return { phrase: rawPhrase, status: "unresolved", matches: [], message: "A TRENCH or BUMP reference needs an alliance context." };
    const alliance = requested.alliance;
    const crossingType = phrase.includes("trench") ? "trench" : "bump";
    const physicalSide = hasAny(phrase, ["non scoring table", "non table", "away side", "far guardrail"]) ? "away"
      : hasAny(phrase, ["scoring table", "table side"]) ? "table"
        : null;
    const allianceSide = /(?:^| )left(?: |$)/.test(phrase) ? "left"
      : /(?:^| )right(?: |$)/.test(phrase) ? "right"
        : null;
    const relativeSide = allianceSide === "left"
      ? (alliance === "red" ? "table" : "away")
      : allianceSide === "right"
        ? (alliance === "red" ? "away" : "table")
        : null;
    if (physicalSide && relativeSide && physicalSide !== relativeSide) {
      return { phrase: rawPhrase, status: "unresolved", matches: [], message: `“${rawPhrase}” gives conflicting physical-side and ${alliance}-driver-relative directions; Bordeaux will not guess which one to use.` };
    }
    const side = physicalSide ?? relativeSide;
    const crossings = REBUILT_2026_CROSSINGS[alliance];
    const candidates = crossingType === "trench"
      ? [
          { id: `${alliance}-trench-table`, label: `${alliance} scoring-table-side TRENCH`, point: crossings.trenchTable, side: "table" as const },
          { id: `${alliance}-trench-away`, label: `${alliance} non-scoring-table-side TRENCH`, point: crossings.trenchAway, side: "away" as const },
        ]
      : [
          { id: `${alliance}-bump-table`, label: `${alliance} scoring-table-side BUMP`, point: crossings.bumpTable, side: "table" as const },
          { id: `${alliance}-bump-away`, label: `${alliance} non-scoring-table-side BUMP`, point: crossings.bumpAway, side: "away" as const },
        ];
    const selected = side ? candidates.filter((candidate) => candidate.side === side) : candidates;
    if (crossingType === "trench" && options.robotHeightM !== undefined && options.robotHeightM > REBUILT_2026_TRENCH_CLEARANCE_M) {
      return { phrase: rawPhrase, status: "unresolved", matches: [], message: `The authored robot height (${options.robotHeightM.toFixed(3)} m) exceeds the TRENCH opening height (0.565 m).` };
    }
    return {
      phrase: rawPhrase,
      status: selected.length === 1 ? "resolved" : "ambiguous",
      matches: selected.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        point: { ...candidate.point },
        confidence: selected.length === 1 ? 1 : 0.5,
        reason: selected.length === 1 ? `Resolved the requested ${allianceSide ? `${alliance}-driver ${allianceSide}` : candidate.side} side without using the current display view as field ownership.` : "Both field sides match; specify alliance-left/right or scoring-table/non-scoring-table side.",
        traversal: crossingType,
      })),
      ...(selected.length > 1 ? { message: `Which ${crossingType.toUpperCase()} side should Bordeaux use?` } : {}),
      ...(crossingType === "trench" && options.robotHeightM === undefined
        ? { warnings: ["TRENCH clearance is unresolved because this project does not specify robot height."] }
        : {}),
    };
  }

  const exact = REBUILT_2026_FIELD.landmarks.filter((landmark) => {
    const terms = [landmark.name, ...landmark.aliases].map(normalized);
    return terms.includes(phrase);
  });
  const matches = exact.flatMap((landmark) => {
    const point = landmark.point ?? (landmark.bounds ? {
      x: (landmark.bounds.xMin + landmark.bounds.xMax) / 2,
      y: (landmark.bounds.yMin + landmark.bounds.yMax) / 2,
    } : null);
    return point ? [{ id: landmark.id, label: landmark.name, officialPoint: point, point: officialToAppPoint(point), confidence: 1, reason: "Exact official field-pack alias, transformed into Bordeaux coordinates.", navigable: landmark.navigable !== false, ...(landmark.traversal ? { traversal: landmark.traversal } : {}) }] : [];
  });
  const descriptive = exact.filter((landmark) => !landmark.point && !landmark.bounds);
  return matches.length
    ? { phrase: rawPhrase, status: matches.length === 1 ? "resolved" : "ambiguous", matches }
    : descriptive.length
      ? { phrase: rawPhrase, status: "unresolved", matches: [], message: `${descriptive.map((landmark) => landmark.name).join(" / ")} is official field vocabulary but is not an on-field robot drive coordinate. ${descriptive.map((landmark) => landmark.description).filter(Boolean).join(" ")}` }
    : { phrase: rawPhrase, status: "unresolved", matches: [], message: `Bordeaux does not recognize “${rawPhrase}” in the active field pack.` };
}

export function resolveProjectFieldTerm(rawPhrase: string, strategy: ProjectStrategyOverlay | undefined, options: ResolveFieldTermOptions = {}): ResolvedFieldTerm {
  const team = resolveStrategyTerm(rawPhrase, strategy);
  const official = resolveFieldTerm(rawPhrase, options);
  if (!team) return official;
  if (official.status === "unresolved") return team;
  return {
    phrase: rawPhrase,
    status: "ambiguous",
    matches: [...team.matches, ...official.matches],
    message: `“${rawPhrase}” matches both team strategy vocabulary and the official field pack; rename the team term to keep authoritative game-manual vocabulary unambiguous.`,
  };
}
