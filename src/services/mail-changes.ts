import { randomUUID } from "node:crypto";
import {
  authorize,
  type AccessContext,
  type Identity,
} from "../core/context.js";
import { References, hash } from "../core/references.js";
import { HubState } from "../core/hub-state.js";
import { AppError } from "../core/errors.js";
export type ChangeState = { message_ref: string; fingerprint: string };
type Delta =
  | { kind: "upsert"; message_ref: string; fingerprint: string }
  | { kind: "missing"; message_ref: string };
interface Snapshot {
  scope: string;
  states: ChangeState[];
  expires: number;
  delta: Delta[];
  complete: boolean;
  result_scope: string;
  baseline_token: string | null;
  missing_unconfirmed: string[];
}
export class MailChanges {
  private identity: Identity;
  constructor(
    identity: Identity,
    private refs: References,
    private state: HubState,
  ) {
    this.identity = {
      owner_id: identity.owner_id,
      account_id: identity.account_id,
    };
  }
  private scope(input: any) {
    return hash({
      ...input,
      limit: undefined,
      cursor: undefined,
      change_token: undefined,
    });
  }
  private load(key: string, input: any) {
    const value = this.state.get<Snapshot>(`mail-changes:${key}`);
    const legacyScope = hash({
      ...input,
      cursor: undefined,
      change_token: undefined,
    });
    if (
      !value ||
      value.expires < Date.now() ||
      ![this.scope(input), legacyScope].includes(value.scope)
    )
      throw new AppError(
        "STALE_REFERENCE",
        "Change checkpoint expired or filters changed.",
        "Restart this query with the current filters.",
      );
    return value;
  }
  previous(ctx: AccessContext, input: any) {
    authorize(ctx, this.identity, "mail:read");
    if (!input.change_token) return [] as ChangeState[];
    const pointer = this.refs.decode<{ key: string }>(
      "mail-changes",
      input.change_token,
    );
    const snapshot = this.load(pointer.key, input);
    if (snapshot.complete === false)
      throw new AppError(
        "STALE_REFERENCE",
        "An incomplete snapshot cannot be used as a change checkpoint.",
        "Continue its pages with the original checkpoint or restart a complete scan.",
      );
    return snapshot.states;
  }
  resume(ctx: AccessContext, input: any) {
    authorize(ctx, this.identity, "mail:read");
    if (!input.cursor) return undefined;
    const cursor = this.refs.decode<{ key: string; offset: number }>(
        "mail-change-page",
        input.cursor,
      ),
      snapshot = this.load(cursor.key, input);
    if (
      !Array.isArray(snapshot.delta) ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset > snapshot.delta.length ||
      snapshot.baseline_token !== (input.change_token ?? null)
    )
      throw new AppError(
        "STALE_REFERENCE",
        "Change page does not match its original checkpoint.",
      );
    return this.page(input, cursor.key, snapshot, cursor.offset);
  }
  capture(
    ctx: AccessContext,
    input: any,
    states: ChangeState[],
    previous: ChangeState[],
    complete: boolean,
    resultScope: string,
  ) {
    authorize(ctx, this.identity, "mail:read");
    const prefix = `mail-changes:${ctx.owner_id}:${ctx.account_id}:`;
    this.state.expireValues(prefix, Date.now());
    if (this.state.countValues(prefix) >= 500)
      throw new AppError(
        "CACHE_LIMIT",
        "Change snapshot limit reached.",
        "Reuse a continuation or checkpoint; run local maintenance after expiry.",
      );
    const namespaces = (rows: ChangeState[]) => {
      const map = new Map<string, string>();
      for (const r of rows) {
        const id = this.refs.decode<any>("hub-message", r.message_ref);
        if (id.backend === "icloud" && id.ref?.uidvalidity)
          map.set(id.folder, String(id.ref.uidvalidity));
      }
      return map;
    };
    const before = namespaces(previous),
      after = namespaces(states);
    for (const [folder, validity] of after)
      if (before.has(folder) && before.get(folder) !== validity)
        throw new AppError(
          "STALE_REFERENCE",
          "Mailbox UIDVALIDITY changed; the old change checkpoint cannot continue.",
          "Restart without change_token to establish the new mailbox identity.",
        );
    const old = new Map(previous.map((x) => [x.message_ref, x.fingerprint])),
      current = new Set(states.map((x) => x.message_ref));
    const missing = previous
      .filter((x) => !current.has(x.message_ref))
      .map((x) => x.message_ref);
    const delta: Delta[] = states
      .filter((x) => old.get(x.message_ref) !== x.fingerprint)
      .map((x) => ({ kind: "upsert", ...x }));
    if (complete)
      delta.push(
        ...missing.map((message_ref) => ({
          kind: "missing" as const,
          message_ref,
        })),
      );
    delta.sort(
      (a, b) =>
        a.message_ref.localeCompare(b.message_ref) ||
        a.kind.localeCompare(b.kind),
    );
    const key = `${ctx.owner_id}:${ctx.account_id}:${randomUUID()}`,
      snapshot: Snapshot = {
        scope: this.scope(input),
        states,
        expires: Date.now() + 86400000,
        delta,
        complete,
        result_scope: resultScope,
        baseline_token: input.change_token ?? null,
        missing_unconfirmed: complete ? [] : missing,
      };
    this.state.put(`mail-changes:${key}`, snapshot);
    return this.page(input, key, snapshot, 0);
  }
  private page(input: any, key: string, snapshot: Snapshot, offset: number) {
    const limit = input.limit ?? 50,
      part = snapshot.delta.slice(offset, offset + limit),
      more = offset + part.length < snapshot.delta.length,
      advanced = snapshot.complete && !more;
    return {
      changes: part
        .filter(
          (x): x is Extract<Delta, { kind: "upsert" }> => x.kind === "upsert",
        )
        .map(({ kind, ...x }) => x),
      missing_from_snapshot: part
        .filter((x) => x.kind === "missing")
        .map((x) => x.message_ref),
      missing_unconfirmed: snapshot.missing_unconfirmed,
      change_token: advanced
        ? this.refs.encode("mail-changes", { key })
        : snapshot.baseline_token,
      next_cursor: more
        ? this.refs.encode("mail-change-page", {
            key,
            offset: offset + part.length,
          })
        : null,
      checkpoint_advanced: advanced,
      complete: advanced,
      scan_complete: snapshot.complete,
      result_scope: snapshot.result_scope,
      total_delta_items: snapshot.delta.length,
      next_action: !snapshot.complete
        ? snapshot.result_scope === "bounded_local_mail_sync"
          ? "Native Mail cannot establish a complete server checkpoint. Use selected local results or an independent protocol connection."
          : "Narrow the filters until the scan is complete; this partial result does not advance the checkpoint."
        : more
          ? "Continue with cursor and the unchanged previous change_token; omit it when null."
          : undefined,
    };
  }
}
