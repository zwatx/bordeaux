import fs from "node:fs/promises";
import path from "node:path";

/** The part of Electron's `safeStorage` the store needs; main passes the real one. */
export interface SafeStorage {
  isEncryptionAvailable(): boolean;
  /** Linux only; Windows (DPAPI) and macOS (Keychain) don't define it. */
  getSelectedStorageBackend?(): "basic_text" | "gnome_libsecret" | "kwallet" | "kwallet5" | "kwallet6" | "unknown";
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
}

/**
 * The custom SSH password for the saved robot connection. `persistent` is false when the OS
 * offers no keychain; the password then lives in memory and Bordeaux asks again after a restart.
 * Plaintext is never written to disk.
 */
export interface RobotPasswordStore {
  readonly persistent: boolean;
  current(): string | null;
  /** null returns to the robot type's default password. */
  replace(password: string | null): Promise<void>;
}

export function sessionRobotPasswordStore(): RobotPasswordStore {
  let password: string | null = null;
  return { persistent: false, current: () => password, replace: async (next) => { password = next; } };
}

/** Opens the keychain-backed store at `file`, or a session store when the keychain is unavailable. */
export async function openRobotPasswordStore(file: string, storage: SafeStorage): Promise<RobotPasswordStore> {
  // Linux falls back to "basic_text" without a keyring, which is plaintext with extra steps.
  if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === "basic_text") {
    let password: string | null = null;
    return { persistent: false, current: () => password, replace: async (next) => {
      // A committed session credential must supersede ciphertext from an earlier keychain session.
      await fs.rm(file, { force: true });
      password = next;
    } };
  }
  let password: string | null = null;
  try { password = storage.decryptString(await fs.readFile(file)); }
  catch { /* Missing or undecryptable (a changed keychain): use the default password. */ }
  return {
    persistent: true,
    current: () => password,
    async replace(next) {
      if (next === null) await fs.rm(file, { force: true });
      else {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temporary, storage.encryptString(next), { mode: 0o600 });
        await fs.rename(temporary, file);
      }
      password = next;
    },
  };
}
