import { describe, expect, it } from "vitest";
import { describeUpdateFailure } from "../src/electron/updateFailure";

describe("update failure recovery", () => {
  it("explains signature verification failure with manual replacement guidance", () => {
    const explanation = describeUpdateFailure("Code signature failed https://untrusted.example/installer");
    expect(explanation).toContain("could not be verified");
    expect(explanation).toContain("replace the installed app manually");
    expect(explanation).not.toContain("untrusted.example");
  });
  it("offers network recovery without repeating the full diagnostic", () => {
    const message = "ECONNRESET: " + "details ".repeat(300);
    const explanation = describeUpdateFailure(message);
    expect(explanation).toContain("Check your internet connection");
    expect(explanation).not.toContain(message);
  });
  it("summarizes a denied GitHub feed request without displaying its HTML response", () => {
    const message = '403 method: GET url: https://github.com/Zw96042/bordeaux/releases.atom\n'
      + '<!DOCTYPE html><html><style>body { background: url(data:image/png;base64,'
      + 'a'.repeat(5000) + '); }</style><body>Forbidden</body></html>';
    const explanation = describeUpdateFailure(message);
    expect(explanation).toContain("HTTP 403");
    expect(explanation).toContain("another network");
    expect(explanation).not.toMatch(/<html|<style|base64|releases\.atom/);
    expect(explanation.length).toBeLessThan(400);
  });

  it("keeps unknown response bodies out of the explanation and out of classification", () => {
    const message = 'Unexpected response\n<html><body>signature network 403 '
      + 'data:image/png;base64,abc</body></html>';
    const explanation = describeUpdateFailure(message);
    expect(explanation).not.toMatch(/verified|HTTP 403|internet|<html|base64/);
    expect(explanation).toContain("releases page");
  });
});

describe("release page links", () => {
  it("opens the offered version's tag page and falls back to the release list for anything else", async () => {
    const { releasePageUrl, OFFICIAL_RELEASES_URL } = await import("../src/electron/updateFailure");
    expect(releasePageUrl("0.2.0-beta.29")).toBe(`${OFFICIAL_RELEASES_URL}/tag/v0.2.0-beta.29`);
    expect(releasePageUrl("1.0.0")).toBe(`${OFFICIAL_RELEASES_URL}/tag/v1.0.0`);
    for (const value of [null, undefined, "", "v1.0.0", "1.0", "1.0.0/../../evil", "1.0.0?x=1", "1.0.0#x"]) expect(releasePageUrl(value)).toBe(OFFICIAL_RELEASES_URL);
  });
});
