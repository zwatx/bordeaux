import { createPackage } from "@electron/asar";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("verifies canonical packaged update metadata and rejects the former owner", async () => {
  const root = process.cwd();
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-package-verification-"));
  try {
    const source = path.join(temporary, "source"), resources = path.join(temporary, "resources");
    const entries: Record<string, string> = {
      "package.json": JSON.stringify({ name: manifest.name, version: manifest.version, main: manifest.main }),
      [manifest.main]: "",
      "dist-electron/electron/agentPlanningWorker.js": "",
      "dist-electron/electron/bdxWorker.js": "",
      "dist-renderer/index.html": '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'"><script type="module" src="./index.js"></script><link rel="stylesheet" href="./index.css">',
      "dist-renderer/index.js": "",
      "dist-renderer/index.css": "",
      "node_modules/js-yaml/index.js": "",
      "node_modules/js-yaml/lib/loader.js": "",
      "node_modules/zod/index.cjs": "",
      "node_modules/zod/v4/index.cjs": "",
      "node_modules/zod/v4/classic/external.cjs": "",
      "node_modules/zod/v4/core/index.cjs": "",
    };
    for (const name of ["@modelcontextprotocol/server", "electron-updater", "ssh2", "zod"]) entries[`node_modules/${name}/package.json`] = "{}";
    for (const [entry, contents] of Object.entries(entries)) {
      const target = path.join(source, entry);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
    }
    await fs.mkdir(resources, { recursive: true });
    for (const resource of ["LICENSE", "NOTICE", "RIGHTS.md", "licenses/OFL-1.1.txt", "licenses/ssh2-MIT.txt", "labview-inspection/InspectCommands.ps1"]) {
      const target = path.join(resources, resource);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "fixture");
    }
    await createPackage(source, path.join(resources, "app.asar"));
    const config = (owner: string) => `provider: github\nowner: ${owner}\nrepo: bordeaux\nchannel: beta\nreleaseType: prerelease\n`;
    const verify = () => promisify(execFile)(process.execPath, [path.join(root, "scripts/verify-package.mjs"), resources], { cwd: root });
    await fs.writeFile(path.join(resources, "app-update.yml"), config("zwatx"));
    expect((await verify()).stdout).toContain("Verified");
    await fs.writeFile(path.join(resources, "app-update.yml"), config("Zw96042"));
    await expect(verify()).rejects.toMatchObject({ stderr: expect.stringContaining("app-update.yml has unexpected owner") });
    await fs.writeFile(path.join(resources, "app-update.yml"), config("zwatx"));
    await fs.rm(path.join(source, "node_modules/js-yaml/lib/loader.js"));
    await createPackage(source, path.join(resources, "app.asar"));
    await expect(verify()).rejects.toMatchObject({ stderr: expect.stringContaining("missing required entry: node_modules/js-yaml/lib/loader.js") });
    await fs.writeFile(path.join(source, "node_modules/js-yaml/lib/loader.js"), "");
    await fs.mkdir(path.join(source, "node_modules/js-yaml/dist"));
    await fs.writeFile(path.join(source, "node_modules/js-yaml/dist/js-yaml.mjs"), "");
    await createPackage(source, path.join(resources, "app.asar"));
    await expect(verify()).rejects.toMatchObject({ stderr: expect.stringContaining("unused YAML browser/ESM bundle") });
    await fs.rm(path.join(source, "node_modules/js-yaml/dist"), { recursive: true });
    await fs.rm(path.join(source, "node_modules/zod/v4/core/index.cjs"));
    await createPackage(source, path.join(resources, "app.asar"));
    await expect(verify()).rejects.toMatchObject({ stderr: expect.stringContaining("missing required entry: node_modules/zod/v4/core/index.cjs") });
    await fs.writeFile(path.join(source, "node_modules/zod/v4/core/index.cjs"), "");
    await fs.writeFile(path.join(source, "node_modules/zod/v4/core/index.js"), "");
    await createPackage(source, path.join(resources, "app.asar"));
    await expect(verify()).rejects.toMatchObject({ stderr: expect.stringContaining("unused Zod ESM dependency variant") });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
