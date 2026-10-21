import { describe, expect, it } from "vitest";
import {
  FIELD_CERTIFICATION_EXPECTED_DIGEST,
  FIELD_SUPPORT_PROMISES,
  certifyField,
} from "../src/shared/field/certification";
import {
  REBUILT_2026_FIELD,
  appToOfficialPoint,
} from "../src/shared/field/rebuilt2026";

describe("field certification", () => {
  it("produces reproducible evidence for the active field", () => {
    const first = certifyField();
    const second = certifyField();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      passed: true,
      digest: FIELD_CERTIFICATION_EXPECTED_DIGEST,
      field: {
        id: "2026-rebuilt",
        revision: REBUILT_2026_FIELD.revision,
        coordinateSchemaId: "wpilib-blue-origin/2026-welded/1",
      },
      supportPromises: FIELD_SUPPORT_PROMISES,
    });
    expect(first.sources).toEqual(REBUILT_2026_FIELD.sources.map(({ label, revision, sha256 }) => ({ label, revision, sha256: sha256 ?? null })));
    expect(first.checks.every((check) => check.passed)).toBe(true);
  });

  it("changes the evidence digest and fails the frozen certification when a source or invariant changes", () => {
    const sourceChanged = structuredClone(REBUILT_2026_FIELD);
    sourceChanged.sources[0].revision = "changed-source-revision";
    const invariantChanged = structuredClone(REBUILT_2026_FIELD);
    invariantChanged.authoringInvariants[0] = "changed invariant";

    const sourceReport = certifyField(sourceChanged);
    const invariantReport = certifyField(invariantChanged);

    expect(sourceReport.digest).not.toBe(FIELD_CERTIFICATION_EXPECTED_DIGEST);
    expect(invariantReport.digest).not.toBe(FIELD_CERTIFICATION_EXPECTED_DIGEST);
    expect(sourceReport.passed).toBe(false);
    expect(invariantReport.passed).toBe(false);
    expect(sourceReport.checks).toContainEqual(expect.objectContaining({ name: "certification.digest", passed: false }));
    expect(invariantReport.checks).toContainEqual(expect.objectContaining({ name: "certification.digest", passed: false }));
  });

  it("names failed transform, portal, obstacle, and representative-route checks", () => {
    const malformedTransform = certifyField(REBUILT_2026_FIELD, {
      transforms: { officialToAppPoint: () => ({ x: Number.NaN, y: 0 }), appToOfficialPoint },
      expectedDigest: null,
    });
    const malformedPortal = structuredClone(REBUILT_2026_FIELD);
    malformedPortal.crossingBarriers[0].portals[0].widthM = 0;
    const malformedObstacle = structuredClone(REBUILT_2026_FIELD);
    malformedObstacle.solidObstacles[0].behavior = "interaction";
    const malformedRoute = structuredClone(REBUILT_2026_FIELD);
    const routePortal = malformedRoute.crossingBarriers[0].portals[0];
    malformedRoute.solidObstacles.push({
      id: "route-blocker",
      name: "Route blocker",
      aliases: [],
      kind: "obstacle",
      behavior: "solid",
      bounds: {
        xMin: routePortal.bounds.xMin,
        xMax: routePortal.bounds.xMax,
        yMin: routePortal.point.y - 0.01,
        yMax: routePortal.point.y + 0.01,
      },
    });

    expect(malformedTransform.checks).toContainEqual(expect.objectContaining({ name: "transform.roundtrip", passed: false }));
    expect(certifyField(malformedPortal, { expectedDigest: null }).checks).toContainEqual(expect.objectContaining({ name: "portal.geometry", passed: false }));
    expect(certifyField(malformedObstacle, { expectedDigest: null }).checks).toContainEqual(expect.objectContaining({ name: "obstacle.shape-and-behavior", passed: false }));
    expect(certifyField(malformedRoute, { expectedDigest: null }).checks).toContainEqual(expect.objectContaining({ name: "route.avoids-solid-obstacles", passed: false }));
  });

  it("rejects a round-tripping transform with the wrong field orientation", () => {
    const report = certifyField(REBUILT_2026_FIELD, {
      transforms: {
        officialToAppPoint: (point) => ({ x: 16.541 - point.x, y: point.y }),
        appToOfficialPoint: (point) => ({ x: 16.541 - point.x, y: point.y }),
      },
      expectedDigest: null,
    });

    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "transform.roundtrip",
      passed: true,
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "transform.alliance-orientation",
      passed: false,
    }));
  });
});
