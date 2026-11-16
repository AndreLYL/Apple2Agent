import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "./errors.js";
export interface CredentialStore {
  get(reference: string, signal: AbortSignal): Promise<string>;
}
export class KeychainCredentialStore implements CredentialStore {
  constructor(private helperPath: string) {}
  async key(reference: string, signal: AbortSignal) {
    try {
      const { stdout } = await promisify(execFile)(
        this.helperPath,
        ["key", reference],
        { signal, timeout: 30000, maxBuffer: 4096 },
      );
      const value = Buffer.from(stdout.trim(), "base64");
      if (value.length !== 32) throw new Error();
      return value;
    } catch {
      throw new AppError(
        "CREDENTIALS_UNAVAILABLE",
        "Private approval key is unavailable.",
        "Allow Apple2Agent to access its own Keychain key in local setup.",
      );
    }
  }
  async get(reference: string, signal: AbortSignal) {
    try {
      const { stdout } = await promisify(execFile)(
        this.helperPath,
        ["get", reference],
        { signal, timeout: 30000, maxBuffer: 4096 },
      );
      if (!stdout.trim()) throw new Error();
      return stdout.trim();
    } catch {
      throw new AppError(
        "CREDENTIALS_UNAVAILABLE",
        "Apple2Agent cannot access its Keychain item.",
        "Run apple2agent setup, or allow this application in the Keychain prompt.",
      );
    }
  }
}
