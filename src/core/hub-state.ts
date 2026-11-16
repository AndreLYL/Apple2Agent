import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase, busyRetry } from "./sqlite.js";
import { hash } from "./references.js";
import type { AccessContext } from "./context.js";
import { AppError } from "./errors.js";

interface Row {
  digest: string;
  state: string;
  receipt: string | null;
}
export class HubState {
  private db;
  constructor(path: string) {
    this.db = openDatabase(path);
    busyRetry(() =>
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS hub_operations (key TEXT PRIMARY KEY,digest TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_leases (key TEXT PRIMARY KEY,holder TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_values (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `),
    );
  }
  get<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM hub_values WHERE key=?")
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  put(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO hub_values VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  insert(key: string, value: unknown) {
    return (
      Number(
        this.db
          .prepare("INSERT OR IGNORE INTO hub_values VALUES(?,?)")
          .run(key, JSON.stringify(value)).changes,
      ) === 1
    );
  }
  compareAndSet(key: string, before: unknown, after: unknown) {
    return (
      Number(
        this.db
          .prepare("UPDATE hub_values SET value=? WHERE key=? AND value=?")
          .run(JSON.stringify(after), key, JSON.stringify(before)).changes,
      ) === 1
    );
  }
  remove(key: string) {
    this.db.prepare("DELETE FROM hub_values WHERE key=?").run(key);
  }
  hasWrite(ctx: AccessContext, operation: string, requestId: string) {
    const r = this.db
      .prepare("SELECT state FROM hub_operations WHERE key=?")
      .get(hash([ctx.owner_id, ctx.account_id, operation, requestId])) as
      { state: string } | undefined;
    return !!r && r.state !== "failed_before_write";
  }
  entries<T>(prefix: string) {
    return (
      this.db
        .prepare(
          "SELECT key,value FROM hub_values WHERE substr(key,1,?)=? LIMIT 10000",
        )
        .all(prefix.length, prefix) as { key: string; value: string }[]
    ).map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }));
  }
  countValues(prefix: string) {
    return Number(
      (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM hub_values WHERE substr(key,1,?)=?",
          )
          .get(prefix.length, prefix) as { n: number }
      ).n,
    );
  }
  // Only disposable, expiring cache values; the write journal is separate and retained.
  expireValues(prefix: string, now: number) {
    this.db
      .prepare(
        "DELETE FROM hub_values WHERE substr(key,1,?)=? AND json_extract(value,'$.expires') < ?",
      )
      .run(prefix.length, prefix, now);
  }
  async locked<T>(
    ctx: AccessContext,
    namespace: string,
    work: () => Promise<T>,
  ) {
    const key = hash([ctx.owner_id, ctx.account_id, namespace]);
    const holder = randomUUID();
    for (;;) {
      ctx.signal.throwIfAborted();
      const now = Date.now();
      const r = this.db
        .prepare(
          "INSERT INTO hub_leases VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET holder=excluded.holder,expires=excluded.expires WHERE hub_leases.expires < ?",
        )
        .run(key, holder, now + 60000, now);
      if (Number(r.changes) === 1) break;
      await delay(25, undefined, { signal: ctx.signal });
    }
    try {
      ctx.signal.throwIfAborted();
      return await work();
    } finally {
      this.db
        .prepare("DELETE FROM hub_leases WHERE key=? AND holder=?")
        .run(key, holder);
    }
  }
  async write<T>(
    ctx: AccessContext,
    operation: string,
    requestId: string,
    input: unknown,
    task: {
      prepare(): Promise<void>;
      write(): Promise<T>;
      verify(receipt?: T): Promise<T | undefined>;
      verification_scope?: "server" | "local";
    },
  ) {
    const key = hash([ctx.owner_id, ctx.account_id, operation, requestId]);
    const digest = hash(input);
    this.db.exec("BEGIN IMMEDIATE");
    let previous: Row | undefined;
    try {
      previous = this.db
        .prepare("SELECT digest,state,receipt FROM hub_operations WHERE key=?")
        .get(key) as Row | undefined;
      if (previous && previous.digest !== digest)
        throw new AppError(
          "REQUEST_CONFLICT",
          "Request ID already has different input.",
        );
      if (!previous)
        this.db
          .prepare("INSERT INTO hub_operations VALUES(?,?,?,NULL,?)")
          .run(key, digest, "started", Date.now());
      else if (previous.state === "failed_before_write")
        this.db
          .prepare("UPDATE hub_operations SET state='started' WHERE key=?")
          .run(key);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    const mark = (state: string, receipt?: T) =>
      this.db
        .prepare(
          "UPDATE hub_operations SET state=?,receipt=COALESCE(?,receipt) WHERE key=?",
        )
        .run(
          state,
          receipt === undefined ? null : JSON.stringify(receipt),
          key,
        );
    if (previous && previous.state !== "failed_before_write") {
      const receipt = previous.receipt
        ? (JSON.parse(previous.receipt) as T)
        : undefined;
      if (previous.state === "verified" && receipt !== undefined)
        return {
          status: "verified",
          verified: true,
          replayed: true,
          current_state_unchecked: true,
          verification_scope: task.verification_scope ?? "local",
          resource: receipt,
        };
      const found = await task.verify(receipt);
      if (found !== undefined) {
        mark("verified", found);
        return {
          status: "verified",
          verified: true,
          replayed: true,
          verification_scope: task.verification_scope ?? "local",
          resource: found,
        };
      }
      throw new AppError(
        "OUTCOME_UNKNOWN",
        "A previous write may have happened.",
        "Reuse this request ID to verify; do not repeat with another ID.",
        false,
        "outcome_unknown",
      );
    }
    try {
      ctx.signal.throwIfAborted();
      await task.prepare();
      ctx.signal.throwIfAborted();
      ctx.assert_current?.();
    } catch (e) {
      mark("failed_before_write");
      throw e;
    }
    let receipt: T;
    try {
      receipt = await task.write();
      mark("accepted", receipt);
    } catch (e) {
      if (e instanceof AppError && e.write_state === "failed_before_write") {
        mark("failed_before_write");
        throw e;
      }
      mark("unknown");
      throw new AppError(
        "OUTCOME_UNKNOWN",
        "The write has no definite receipt.",
        "Recover using this request ID; do not resubmit.",
        false,
        "outcome_unknown",
      );
    }
    try {
      const found = await task.verify(receipt);
      if (found !== undefined) {
        mark("verified", found);
        return {
          status: "verified",
          verified: true,
          replayed: false,
          verification_scope: task.verification_scope ?? "local",
          resource: found,
        };
      }
    } catch {
      /* Accepted writes must not be submitted twice. */
    }
    return {
      status: "accepted_unverified",
      verified: false,
      replayed: false,
      resource: receipt,
      next_action: "Retry with the same request_id to verify.",
    };
  }
  close() {
    this.db.close();
  }
}
