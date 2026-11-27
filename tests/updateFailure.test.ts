import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { describeUpdateFailure, freeUpdateSpace, UPDATE_FREE_BYTES } from "../src/electron/updateFailure";
// @ts-expect-error The update panel's sentence helper is JavaScript.
import { firstFact } from "../src/renderer/lib/projectLifecycle";

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

describe("update failure on a full disk", () => {
  // What Squirrel.Mac reports when it could not finish unpacking the app before checking its signature.
  const squirrel = "Code signature at URL file:///Users/me/Library/Caches/org.frc2468.bordeaux.ShipIt/update.abc/Bordeaux.app/ did not pass validation: a sealed resource is missing or invalid";
  const low = UPDATE_FREE_BYTES - 1;

  it("explains a signature failure as disk space when the disk is nearly full, in the sentence the panel shows", () => {
    const explanation = describeUpdateFailure(squirrel, 287 * 1024 ** 2);
    expect(firstFact(explanation)).toBe("Free up at least 1 GB of disk space, then try the update again");
    expect(explanation).not.toMatch(/verified|ShipIt/);
  });

  it("keeps the verification explanation when there is room or the space is unknown", () => {
    expect(describeUpdateFailure(squirrel, UPDATE_FREE_BYTES)).toContain("could not be verified");
    expect(describeUpdateFailure(squirrel, null)).toContain("could not be verified");
    expect(describeUpdateFailure(squirrel)).toContain("could not be verified");
  });

  it("recognizes a disk-full error whatever the space reading", () => {
    for (const message of ["ENOSPC: no space left on device, write", "No space left on device", "There is not enough free space on the disk.", "The disk is full"]) {
      expect(describeUpdateFailure(message, null)).toContain("1 GB of disk space");
      expect(describeUpdateFailure(message, 50 * 1024 ** 3)).toContain("1 GB of disk space");
    }
  });

  it("leaves network and access advice alone on a nearly full disk", () => {
    expect(describeUpdateFailure("ECONNRESET", low)).toContain("Check your internet connection");
    expect(describeUpdateFailure("403 Forbidden", low)).toContain("HTTP 403");
    expect(describeUpdateFailure("Unexpected end of archive", low)).toContain("1 GB of disk space");
  });

  it("reads the least free space among the update's volumes and skips ones it cannot read", () => {
    const free = freeUpdateSpace([os.tmpdir()]);
    expect(free).toBeGreaterThan(0);
    expect(freeUpdateSpace([path.join(os.tmpdir(), "bordeaux-missing-volume-" + process.pid), os.tmpdir()])).toBe(free);
    expect(freeUpdateSpace([path.join(os.tmpdir(), "bordeaux-missing-volume-" + process.pid)])).toBeNull();
    expect(freeUpdateSpace([])).toBeNull();
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
