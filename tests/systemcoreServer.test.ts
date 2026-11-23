// The SystemCore server (src/hosts/systemcore/server.py) run on a temporary home and called over HTTP.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const python = spawnSync("python3", ["--version"]).status === 0;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const b64 = (data: string) => Buffer.from(data).toString("base64");

describe.skipIf(!python)("SystemCore server", () => {
  let server: ChildProcess, home: string, base: string, host: string;

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-server-")));
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
    });
    host = `127.0.0.1:${port}`;
    base = `http://${host}`;
    await fs.mkdir(path.join(home, "static"));
    await fs.writeFile(path.join(home, "static", "index.html"), "<!doctype html>");
    server = spawn("python3", ["src/hosts/systemcore/server.py", "--host", "127.0.0.1", "--port", String(port), "--home", path.join(home, "robot"), "--static", path.join(home, "static")], { stdio: "ignore" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(base + "/api/info").then((response) => response.ok, () => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("server.py did not start");
  });
  afterAll(async () => {
    server?.kill();
    await fs.rm(home, { recursive: true, force: true });
  });

  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Origin: base, ...headers } });
  const json = async (response: Response) => ({ status: response.status, body: await response.json() });

  it("refuses writes from another origin, without an origin, or as a form", async () => {
    expect((await post("/api/settings", { lastProject: "x" }, { Origin: "http://attacker.example" })).status).toBe(403);
    expect((await fetch(base + "/api/settings", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status).toBe(403);
    expect((await post("/api/settings", {}, { "Content-Type": "text/plain" })).status).toBe(403);
  });

  it("refuses API requests addressed to a rebound name", async () => {
    const rebound = await new Promise<number>((resolve, reject) => {
      // fetch() won't override Host, so send the request by hand.
      const socket = net.connect(Number(host.split(":")[1]), "127.0.0.1", () => socket.write("GET /api/projects HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n"));
      let reply = "";
      socket.on("data", (chunk) => { reply += chunk; }).on("end", () => resolve(Number(reply.split(" ")[1]))).on("error", reject);
    });
    expect(rebound).toBe(403);
    expect((await fetch(base + "/api/projects")).status).toBe(200);
  });

  it("refuses a save that would overwrite a source file changed on the robot", async () => {
    const first = await json(await post("/api/commit", { name: "Team", create: true, expectedWorkspaceSha256: null, workspace: "{}",
      writes: [{ file: "Paths/Auto.path", base64: b64("v1"), expectedSha256: null }], removes: [] }));
    expect(first.status).toBe(200);
    const file = path.join(home, "robot", "projects", "Team", "Paths", "Auto.path");
    await fs.writeFile(file, "edited over ssh");
    const second = await json(await post("/api/commit", { name: "Team", create: false, expectedWorkspaceSha256: first.body.workspaceSha256, workspace: "{\"next\":1}",
      writes: [{ file: "Paths/Auto.path", base64: b64("v2"), expectedSha256: sha256("v1") }], removes: [] }));
    expect(second).toMatchObject({ status: 409, body: { error: expect.stringContaining("Paths/Auto.path changed on the robot") } });
    expect(second.body.error).toContain("Save copy");
    expect(await fs.readFile(file, "utf8")).toBe("edited over ssh");
    expect(await fs.readFile(path.join(home, "robot", "projects", "Team", ".bordeaux-workspace.json"), "utf8")).toBe("{}");
    // The remedy the message names: Save copy writes this version to a new project and leaves the robot's file alone.
    const copy = await post("/api/commit", { name: "Team copy", create: true, expectedWorkspaceSha256: null, workspace: "{\"next\":1}",
      writes: [{ file: "Paths/Auto.path", base64: b64("v2"), expectedSha256: null }], removes: [] });
    expect(copy.status).toBe(200);
    expect(await fs.readFile(file, "utf8")).toBe("edited over ssh");
  });

  it("publishes only a reviewed batch, and a bad destination replaces nothing", async () => {
    const files = (a: string, b: string) => [{ fileName: "A.bdx", sha256: sha256(a), base64: b64(a) }, { fileName: "B.bdx", sha256: sha256(b), base64: b64(b) }];
    const paths = path.join(home, "robot", "paths");
    expect((await post("/api/push/confirm", { operationId: "never-reviewed" })).status).toBe(409);

    const ok = await json(await post("/api/push/prepare", { files: files("a1", "b1") }));
    expect(await fs.readdir(paths)).toEqual([]);
    expect(await json(await post("/api/push/confirm", { operationId: ok.body.operationId }))).toMatchObject({ status: 200, body: { files: ["A.bdx", "B.bdx"] } });
    expect((await post("/api/push/confirm", { operationId: ok.body.operationId })).status).toBe(409);

    const bad = await json(await post("/api/push/prepare", { files: files("a2", "b2") }));
    await fs.rm(path.join(paths, "B.bdx"));
    await fs.mkdir(path.join(paths, "B.bdx"));
    expect(await json(await post("/api/push/confirm", { operationId: bad.body.operationId })))
      .toMatchObject({ status: 500, body: { error: expect.stringContaining("No robot files were replaced") } });
    expect(await fs.readFile(path.join(paths, "A.bdx"), "utf8")).toBe("a1");
    expect((await fs.readdir(paths)).sort()).toEqual(["A.bdx", "B.bdx"]);
  });

  it("refuses a damaged or duplicate batch at review", async () => {
    expect((await post("/api/push/prepare", { files: [{ fileName: "A.bdx", sha256: sha256("x"), base64: b64("y") }] })).status).toBe(400);
    expect((await post("/api/push/prepare", { files: [{ fileName: "A.bdx", sha256: sha256("x"), base64: b64("x") }, { fileName: "a.bdx", sha256: sha256("x"), base64: b64("x") }] })).status).toBe(400);
  });
  const create = (name: string, writes: Array<Record<string, unknown>> = [], workspace = "{}") =>
    post("/api/commit", { name, create: true, expectedWorkspaceSha256: null, workspace, writes, removes: [] });

  it("refuses a generated BDX that isn't the one Bordeaux wrote", async () => {
    const first = await json(await create("Outputs", [{ file: "Paths/Auto.bdx", base64: b64("bdx1"), expectedSha256: null }]));
    const bdx = path.join(home, "robot", "projects", "Outputs", "Paths", "Auto.bdx");
    await fs.writeFile(bdx, "placed by hand");
    const second = await post("/api/commit", { name: "Outputs", create: false, expectedWorkspaceSha256: first.body.workspaceSha256, workspace: "{}",
      writes: [{ file: "Paths/Auto.bdx", base64: b64("bdx2"), expectedSha256: sha256("bdx1") }], removes: [] });
    expect(second.status).toBe(409);
    expect(await fs.readFile(bdx, "utf8")).toBe("placed by hand");
    expect((await create("No hash", [{ file: "Paths/Auto.bdx", base64: b64("bdx1") }])).status).toBe(400);
    // A tracked file deleted over SSH is written again, as on the desktop.
    await fs.rm(bdx);
    const third = await post("/api/commit", { name: "Outputs", create: false, expectedWorkspaceSha256: first.body.workspaceSha256, workspace: "{}",
      writes: [{ file: "Paths/Auto.bdx", base64: b64("bdx2"), expectedSha256: sha256("bdx1") }], removes: [] });
    expect(third.status).toBe(200);
    expect(await fs.readFile(bdx, "utf8")).toBe("bdx2");
  });

  it("never reads or writes through a linked folder", async () => {
    const robot = path.join(home, "robot"), paths = path.join(robot, "paths");
    const before = (await fs.readdir(paths)).sort();
    // A project whose Paths folder leads into the robot code's folder.
    const team = await json(await create("Linked", [{ file: "Routines/Auto.routine", base64: b64("r"), expectedSha256: null }]));
    await fs.symlink(paths, path.join(robot, "projects", "Linked", "Paths"));
    const through = await post("/api/commit", { name: "Linked", create: false, expectedWorkspaceSha256: team.body.workspaceSha256, workspace: "{}",
      writes: [{ file: "Paths/Evil.bdx", base64: b64("x"), expectedSha256: null }], removes: [] });
    expect(through.status).toBe(400);
    expect((await fs.readdir(paths)).sort()).toEqual(before);
    // A project folder that is itself a link, and a push folder under a linked parent.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-outside-"));
    await fs.mkdir(path.join(outside, "Elsewhere"));
    await fs.writeFile(path.join(outside, "Elsewhere", ".bordeaux-workspace.json"), "{}");
    await fs.symlink(path.join(outside, "Elsewhere"), path.join(robot, "projects", "Elsewhere"));
    expect((await fetch(base + "/api/projects/Elsewhere/workspace")).status).toBe(400);
    await fs.symlink(outside, path.join(robot, "mounted"));
    expect((await post("/api/settings", { pushDirectory: path.join(robot, "mounted", "paths") })).status).toBe(400);
    expect((await post("/api/push/prepare", { directory: path.join(robot, "mounted", "paths"), files: [{ fileName: "A.bdx", sha256: sha256("a"), base64: b64("a") }] })).status).toBe(400);
    expect(await fs.readdir(outside)).toEqual(["Elsewhere"]);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("accepts only project names the desktop accepts", async () => {
    for (const name of ["CON", "nul .txt", "Trailing.", "x".repeat(121), "😀".repeat(64), ".hidden", "Tab\there"]) {
      expect((await create(name)).status, name).toBe(400);
    }
    expect((await create("Week 3 autos")).status).toBe(200);
    // A project saved under an older rule still opens, and its save points to Save copy.
    await fs.mkdir(path.join(home, "robot", "projects", "Aux"));
    await fs.writeFile(path.join(home, "robot", "projects", "Aux", ".bordeaux-workspace.json"), "{}");
    expect((await fetch(base + "/api/projects/Aux/workspace")).status).toBe(200);
    expect((await post("/api/settings", { lastProject: "Aux" })).status).toBe(200);
    const save = await json(await post("/api/commit", { name: "Aux", create: false, expectedWorkspaceSha256: sha256("{}"), workspace: "{}", writes: [], removes: [] }));
    expect(save).toMatchObject({ status: 400, body: { error: expect.stringContaining("Save copy") } });
  });

  it.skipIf(process.getuid?.() === 0)("fails a save that can't write its workspace with nothing replaced", async () => {
    const first = await json(await create("Full", [{ file: "Paths/Auto.path", base64: b64("v1"), expectedSha256: null }]));
    const folder = path.join(home, "robot", "projects", "Full");
    // The workspace's folder refuses new files, as a full disk would; Paths/ still accepts them.
    await fs.chmod(folder, 0o555);
    try {
      const failed = await post("/api/commit", { name: "Full", create: false, expectedWorkspaceSha256: first.body.workspaceSha256, workspace: "{\"next\":1}",
        writes: [{ file: "Paths/Auto.path", base64: b64("v2"), expectedSha256: sha256("v1") }], removes: [] });
      expect(failed.status).toBe(500);
    } finally { await fs.chmod(folder, 0o755); }
    expect(await fs.readFile(path.join(folder, "Paths", "Auto.path"), "utf8")).toBe("v1");
    expect(await fs.readFile(path.join(folder, ".bordeaux-workspace.json"), "utf8")).toBe("{}");
    expect((await fs.readdir(path.join(folder, "Paths"))).filter((name) => name.startsWith("."))).toEqual([]);
  });
});
