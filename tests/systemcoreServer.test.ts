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
});
