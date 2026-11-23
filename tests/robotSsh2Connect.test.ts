import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { connectRobotSftp } from "../src/electron/robotSsh2Session";

// Real ssh2 against local sockets: cancellation, timeout and refusal before any SFTP session exists.
describe("robot SFTP connection", () => {
  it("cancels before opening a network connection", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(connectRobotSftp({
      endpoint: { host: "127.0.0.1", port: 1 },
      credentials: { username: "admin", password: "" },
      signal: controller.signal,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("times out a peer that accepts TCP but never completes SSH", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    try {
      await expect(connectRobotSftp({
        endpoint: { host: "127.0.0.1", port: address.port },
        credentials: { username: "admin", password: "" },
        signal: new AbortController().signal,
        timeoutMs: 25,
      })).rejects.toMatchObject({ code: "timed_out" });
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("reports SFTP unavailability without claiming it detected FMS", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    let failure: Error & { code?: string };
    try {
      await connectRobotSftp({
        endpoint: { host: "127.0.0.1", port: address.port },
        credentials: { username: "admin", password: "team-secret" },
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      });
      throw new Error("Expected the closed test endpoint to be unavailable");
    } catch (error) {
      failure = error as Error & { code?: string };
    }
    expect(failure.code).toBe("unavailable");
    expect(failure.message).toContain("ECONNREFUSED");
    expect(failure.message).not.toContain("FMS");
    expect(failure.message).not.toContain("team-secret");
  });
});
