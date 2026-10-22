import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("beta diagnostic dialog", () => {
  it("requires a generated local preview before saving its capability", () => {
    const dialog = fs.readFileSync(new URL("../src/renderer/components/DiagnosticBundleDialog.jsx", import.meta.url), "utf8");

    expect(dialog).toContain("previewBetaDiagnostic(getProject())");
    expect(dialog).toContain("readOnly: true");
    expect(dialog).toContain("saveBetaDiagnostic(preview.previewId)");
    expect(dialog).not.toContain("saveBetaDiagnostic(preview.contents)");
    expect(dialog).toContain("Nothing is sent.");
    // The connection-to-diagnostics interaction is exercised in verify-library-ui-electron.cjs.
  });
});
