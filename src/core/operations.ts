import { DatabaseSync } from "node:sqlite";
import { openDatabase, busyRetry } from "./sqlite.js";
import { AppError } from "./errors.js";
import { hash } from "./references.js";
import type { AccessContext } from "./context.js";
type State =
  "submitted" | "accepted" | "verified" | "failed_before_write" | "unknown";
interface RecordRow {
  digest: string;
  state: State;
}
export interface OperationStore {
  claim(key: string, digest: string): { fresh: boolean; state: State };
  set(key: string, state: State): void;
  close(): void;
}
export class SQLiteOperationStore implements OperationStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = openDatabase(path);
    busyRetry(() =>
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL)",
      ),
    );
  }
  claim(key: string, digest: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT digest,state FROM operations WHERE key=?")
        .get(key) as RecordRow | undefined;
      if (row && row.digest !== digest)
        throw new AppError(
          "REQUEST_CONFLICT",
          "request_id was already used for different input.",
          "Reuse its original input, or use a new id for a new intention.",
        );
      const fresh = !row || row.state === "failed_before_write";
      if (!row)
        this.db
          .prepare("INSERT INTO operations VALUES(?,?,?,?)")
          .run(key, digest, "submitted", Date.now());
      else if (fresh)
        this.db
          .prepare("UPDATE operations SET state=? WHERE key=?")
          .run("submitted", key);
      this.db.exec("COMMIT");
      return { fresh, state: fresh ? "submitted" : row!.state } as const;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  set(key: string, state: State) {
    this.db
      .prepare("UPDATE operations SET state=? WHERE key=?")
      .run(state, key);
  }
  close() {
    this.db.close();
  }
}
export async function executeWrite<T>(
  store: OperationStore,
  ctx: AccessContext,
  operation: string,
  requestId: string,
  input: unknown,
  task: {
    prepare(): Promise<void>;
    write(): Promise<void>;
    verify(): Promise<T | undefined>;
  },
) {
  const key = hash([ctx.owner_id, ctx.account_id, operation, requestId]);
  const claim = store.claim(key, hash(input));
  if (!claim.fresh) {
    let existing: T | undefined;
    try {
      existing = await task.verify();
    } catch (e) {
      if (
        e instanceof AppError &&
        ["REQUEST_CONFLICT", "PERMISSION_DENIED", "STALE_REFERENCE"].includes(
          e.code,
        )
      )
        throw e; /* Keep uncertain writes protected. */
    }
    if (existing) {
      store.set(key, "verified");
      return {
        status:
          operation === "calendar_create"
            ? "created_verified"
            : "draft_saved_verified",
        verified: true,
        replayed: true,
        resource: existing,
      };
    }
    if (claim.state === "verified")
      throw new AppError(
        "NOT_FOUND",
        "The previously saved resource is no longer readable.",
        "Search again; this request_id will not create another copy.",
      );
    if (claim.state === "accepted")
      return {
        status: "write_accepted_unverified",
        verified: false,
        replayed: true,
        next_action:
          "Retry with the same request_id to verify; do not create another copy.",
      };
    throw new AppError(
      "OUTCOME_UNKNOWN",
      "A previous write may already exist.",
      "Retry verification with the same request_id. Do not blindly resubmit.",
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
    store.set(key, "failed_before_write");
    throw e;
  }
  try {
    await task.write();
    store.set(key, "accepted");
  } catch (e) {
    if (e instanceof AppError && e.write_state === "failed_before_write") {
      store.set(key, "failed_before_write");
      throw e;
    }
    store.set(key, "unknown");
    throw new AppError(
      "OUTCOME_UNKNOWN",
      "The connection ended without a definite write result.",
      "Reuse this request_id to verify. Do not repeat with a new id.",
      false,
      "outcome_unknown",
    );
  }
  try {
    const resource = await task.verify();
    if (resource) {
      store.set(key, "verified");
      return {
        status:
          operation === "calendar_create"
            ? "created_verified"
            : "draft_saved_verified",
        verified: true,
        replayed: false,
        resource,
      };
    }
  } catch {
    /* A successful upstream write must not be submitted again. */
  }
  return {
    status: "write_accepted_unverified",
    verified: false,
    next_action:
      "Retry using the same request_id to verify the saved resource.",
  };
}
