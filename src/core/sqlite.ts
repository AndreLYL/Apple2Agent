import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";

/** WAL negotiation can return BUSY immediately while another process creates it. */
export function busyRetry<T>(fn: () => T, timeout = 5000): T {
  const until = Date.now() + timeout;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      return fn();
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if ((code !== 5 && code !== 6) || Date.now() >= until) throw error;
      Atomics.wait(sleeper, 0, 0, Math.min(25, until - Date.now()));
    }
  }
}

export function openDatabase(path: string) {
  const db = new DatabaseSync(path);
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout=5000");
    busyRetry(() => db.exec("PRAGMA journal_mode=WAL"));
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
