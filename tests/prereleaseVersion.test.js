import { describe, expect, it } from "vitest";
import { resolvePrereleaseVersion } from "../scripts/resolve-prerelease-version.mjs";

const tagged = (...versions) => (version) => versions.includes(version);

describe("prerelease version resolution", () => {
  it("reuses an untagged checked-in beta, so a hand bump or a failed run's retry needs no new commit", () => {
    expect(resolvePrereleaseVersion({ requested: "", current: "0.2.0-beta.37", released: tagged("0.2.0-beta.36") })).toBe("0.2.0-beta.37");
  });

  it("takes the next beta number after a released checked-in beta", () => {
    expect(resolvePrereleaseVersion({ requested: "", current: "0.2.0-beta.36", released: tagged("0.2.0-beta.36") })).toBe("0.2.0-beta.37");
    expect(resolvePrereleaseVersion({ requested: " ", current: "1.4.2-beta.9", released: tagged("1.4.2-beta.9") })).toBe("1.4.2-beta.10");
  });

  it("refuses to skip numbers when the next beta is already tagged", () => {
    expect(() => resolvePrereleaseVersion({ requested: "", current: "0.2.0-beta.36", released: tagged("0.2.0-beta.36", "0.2.0-beta.37") }))
      .toThrow(/v0\.2\.0-beta\.37 already exists/);
  });

  it("asks for an explicit version when the checked-in version is not a beta", () => {
    expect(() => resolvePrereleaseVersion({ requested: "", current: "0.2.0", released: tagged() })).toThrow(/explicit/);
  });

  it.each(["0.2.0", "v0.2.0-beta.1", "0.2.0-beta", "0.2.0-rc.1", "0.2.0-beta.1 extra"])("rejects malformed requested version %j", (requested) => {
    expect(() => resolvePrereleaseVersion({ requested, current: "0.2.0-beta.36", released: tagged() })).toThrow(/must look like/);
  });

  it("rejects a requested version that is already tagged", () => {
    expect(() => resolvePrereleaseVersion({ requested: "0.2.0-beta.36", current: "0.2.0-beta.36", released: tagged("0.2.0-beta.36") }))
      .toThrow(/already exists/);
  });

  it("uses a valid requested version as given, trimmed", () => {
    expect(resolvePrereleaseVersion({ requested: " 0.3.0-beta.1 ", current: "0.2.0-beta.36", released: tagged("0.2.0-beta.36") })).toBe("0.3.0-beta.1");
  });

  it.each([
    ["0.1.0-beta.1", "0.2.0-beta.36"],
    ["0.2.0-beta.35", "0.2.0-beta.36"],
    ["0.2.0-beta.99", "0.2.0"],
  ])("rejects requested version %j older than the checked-in %j", (requested, current) => {
    expect(() => resolvePrereleaseVersion({ requested, current, released: tagged(current) })).toThrow(/older than the checked-in/);
  });

  it("accepts an explicit version that equals or follows the checked-in one", () => {
    expect(resolvePrereleaseVersion({ requested: "0.2.0-beta.37", current: "0.2.0-beta.37", released: tagged() })).toBe("0.2.0-beta.37");
    expect(resolvePrereleaseVersion({ requested: "0.2.0-beta.10", current: "0.2.0-beta.9", released: tagged("0.2.0-beta.9") })).toBe("0.2.0-beta.10");
    expect(resolvePrereleaseVersion({ requested: "0.2.1-beta.1", current: "0.2.0", released: tagged("0.2.0") })).toBe("0.2.1-beta.1");
  });
});
