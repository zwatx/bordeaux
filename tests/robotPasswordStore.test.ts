import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRobotPasswordStore, sessionRobotPasswordStore, type SafeStorage } from "../src/electron/robotPasswordStore";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true, force: true }); });
async function file() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "bordeaux-robot-password-"));
  folders.push(folder);
  return path.join(folder, "robot-ssh-password.bin");
}
// Reversible stand-in for the OS keychain cipher; never the plaintext bytes.
function keychain(backend: ReturnType<NonNullable<SafeStorage["getSelectedStorageBackend"]>> = "gnome_libsecret", available = true): SafeStorage {
  const flip = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0x5a));
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => flip(Buffer.from(text, "utf8")),
    decryptString: (bytes) => { if (bytes[0] === 0xff) throw new Error("Keychain cannot decrypt this value"); return flip(bytes).toString("utf8"); },
  };
}

describe("remembered robot SSH password", () => {
  it("encrypts a custom password with the OS keychain and restores it after a restart", async () => {
    const target = await file();
    const store = await openRobotPasswordStore(target, keychain());
    expect(store.persistent).toBe(true);
    await store.replace("team-2468-secret");
    expect(store.current()).toBe("team-2468-secret");
    expect((await fs.readFile(target)).includes(Buffer.from("team-2468-secret"))).toBe(false);
    expect((await openRobotPasswordStore(target, keychain())).current()).toBe("team-2468-secret");
  });

  it("uses the keychain on Windows and macOS, where safeStorage has no backend query", async () => {
    const target = await file();
    const { getSelectedStorageBackend: _linuxOnly, ...windows } = keychain();
    const store = await openRobotPasswordStore(target, windows);
    expect(store.persistent).toBe(true);
    await store.replace("team-2468-secret");
    expect((await openRobotPasswordStore(target, windows)).current()).toBe("team-2468-secret");
  });

  it("forgets the stored password when the default is chosen", async () => {
    const target = await file();
    const store = await openRobotPasswordStore(target, keychain());
    await store.replace("team-2468-secret");
    await store.replace(null);
    expect(store.current()).toBeNull();
    await expect(fs.access(target)).rejects.toThrow();
    expect((await openRobotPasswordStore(target, keychain())).current()).toBeNull();
  });

  it.each([
    ["plain-text Linux backend", keychain("basic_text")],
    ["unavailable encryption", keychain("unknown", false)],
  ])("keeps the password only for this session with %s", async (_name, storage) => {
    const target = await file();
    const store = await openRobotPasswordStore(target, storage);
    expect(store.persistent).toBe(false);
    await store.replace("team-2468-secret");
    expect(store.current()).toBe("team-2468-secret");
    await expect(fs.access(target)).rejects.toThrow();
    expect((await openRobotPasswordStore(target, storage)).current()).toBeNull();
  });

  it("ignores a stored password the keychain can no longer decrypt or protect", async () => {
    const target = await file();
    await fs.writeFile(target, Buffer.from([0xff, 1, 2, 3]));
    expect((await openRobotPasswordStore(target, keychain())).current()).toBeNull();
    const saved = await openRobotPasswordStore(target, keychain());
    await saved.replace("team-2468-secret");
    expect((await openRobotPasswordStore(target, keychain("basic_text"))).current()).toBeNull();
  });

  it("offers a session-only store for callers without a keychain", async () => {
    const store = sessionRobotPasswordStore();
    expect(store.persistent).toBe(false);
    expect(store.current()).toBeNull();
    await store.replace("x");
    expect(store.current()).toBe("x");
  });
});
