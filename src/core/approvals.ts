import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  authorize,
  requireGrant,
  type ResourceGrants,
  type AccessContext,
  type Capability,
  type Identity,
} from "./context.js";
import { hash } from "./references.js";
import { HubState } from "./hub-state.js";
import { AppError } from "./errors.js";

interface Action {
  id: string;
  owner_id: string;
  account_id: string;
  operation: string;
  capability: Capability;
  digest: string;
  ciphertext: string;
  expires: number;
  state:
    "pending" | "approved" | "rejected" | "released" | "executed" | "unknown";
  receipt?: unknown;
  grants?: { kind: keyof ResourceGrants; id: string }[];
}
/** review() is a trusted local API. It is never registered as an MCP tool. */
export class ApprovalStore {
  private identity: Identity;
  constructor(
    private state: HubState,
    identity: Identity,
    private encryptionKey: () => Promise<Buffer>,
  ) {
    this.identity = {
      owner_id: identity.owner_id,
      account_id: identity.account_id,
    };
  }
  prune() {
    let cleared = 0;
    for (const { key, value } of this.state.entries<Action>("approval:")) {
      if (
        value.ciphertext &&
        (value.expires < Date.now() ||
          value.state === "rejected" ||
          value.state === "executed")
      ) {
        if (this.state.compareAndSet(key, value, { ...value, ciphertext: "" }))
          cleared++;
      }
    }
    return { cleared_payloads: cleared, retained_replay_tombstones: true };
  }
  discard(ctx: AccessContext, id: string) {
    const a = this.load(ctx, id);
    if (!["pending", "approved"].includes(a.state))
      throw new AppError(
        "OUTCOME_UNKNOWN",
        "A released action cannot be discarded or released again.",
      );
    this.state.compareAndSet(`approval:${id}`, a, {
      ...a,
      state: "rejected",
      ciphertext: "",
    });
    return this.status(ctx, id);
  }
  private async seal(payload: unknown) {
    const key = await this.encryptionKey();
    if (key.length !== 32)
      throw new AppError(
        "CREDENTIALS_UNAVAILABLE",
        "Invalid approval encryption key.",
      );
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    const raw = Buffer.from(JSON.stringify(payload));
    if (raw.length > 8 * 1024 * 1024)
      throw new AppError(
        "CONTENT_TOO_LARGE",
        "Approval payload exceeds 8 MiB.",
      );
    const data = Buffer.concat([cipher.update(raw), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  private async open(action: Action) {
    const raw = Buffer.from(action.ciphertext, "base64"),
      key = await this.encryptionKey();
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        raw.subarray(0, 12),
      );
      decipher.setAuthTag(raw.subarray(12, 28));
      const value = JSON.parse(
        Buffer.concat([
          decipher.update(raw.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
      if (hash(value) !== action.digest) throw new Error();
      return value as unknown;
    } catch {
      throw new AppError(
        "CREDENTIALS_UNAVAILABLE",
        "Approval payload cannot be authenticated.",
      );
    }
  }
  private load(ctx: AccessContext, id: string) {
    const action = this.state.get<Action>(`approval:${id}`);
    if (
      !action ||
      action.owner_id !== ctx.owner_id ||
      action.account_id !== ctx.account_id
    )
      throw new AppError(
        "NOT_FOUND",
        "Approval is not available for this account.",
      );
    authorize(ctx, this.identity, action.capability);
    for (const grant of action.grants ?? []) {
      requireGrant(ctx, grant.kind, grant.id);
      if (
        grant.kind === "message_recipients" &&
        ctx.grants?.message_never_send?.includes(grant.id)
      )
        throw new AppError(
          "PERMISSION_DENIED",
          "A recipient is now on the never-send list.",
        );
    }
    if (action.expires < Date.now() && action.state !== "executed") {
      if (action.ciphertext)
        this.state.compareAndSet(`approval:${id}`, action, {
          ...action,
          ciphertext: "",
        });
      throw new AppError(
        "APPROVAL_EXPIRED",
        "Approval expired.",
        "Prepare a new request and review its content.",
      );
    }
    return action;
  }
  async request(
    ctx: AccessContext,
    operation: string,
    requestId: string,
    capability: Capability,
    payload: unknown,
    ttl = 86400000,
  ) {
    authorize(ctx, this.identity, capability);
    this.prune();
    if (
      this.state
        .entries<Action>("approval:")
        .filter(
          (x) =>
            ["pending", "approved"].includes(x.value.state) &&
            x.value.expires > Date.now(),
        ).length >= 500
    )
      throw new AppError(
        "QUEUE_FULL",
        "Review or discard pending actions before queuing more.",
      );
    const id = hash([ctx.owner_id, ctx.account_id, operation, requestId]);
    const key = `approval:${id}`;
    const existing = this.state.get<Action>(key);
    const digest = hash(payload);
    if (existing) {
      this.load(ctx, id);
      if (
        existing.digest !== digest ||
        existing.operation !== operation ||
        existing.capability !== capability
      )
        throw new AppError(
          "REQUEST_CONFLICT",
          "Approval request has different content.",
        );
      return this.status(ctx, id);
    }
    const action: Action = {
      id,
      ...this.identity,
      operation,
      capability,
      digest,
      ciphertext: await this.seal(payload),
      expires: Date.now() + ttl,
      state: "pending",
      grants: (payload as any)?.authorization_grants,
    };
    if (!this.state.insert(key, action)) {
      const raced = this.load(ctx, id);
      if (raced.digest !== digest)
        throw new AppError(
          "REQUEST_CONFLICT",
          "Concurrent approval has different content.",
        );
    }
    return this.status(ctx, id);
  }
  status(ctx: AccessContext, id: string) {
    const action = this.load(ctx, id);
    return {
      action_id: id,
      operation: action.operation,
      status: action.state === "pending" ? "queued_for_approval" : action.state,
      expires_at: new Date(action.expires).toISOString(),
      sent: action.operation.endsWith("send")
        ? action.state === "executed" &&
          ((action.receipt as any)?.status === "sent_confirmed" ||
            ((action.receipt as any)?.status === "upstream_accepted" &&
              (action.receipt as any)?.accepted_count > 0))
        : undefined,
      receipt: action.receipt,
      next_action:
        action.state === "pending"
          ? "Review this action in the trusted native approval window. An MCP argument cannot approve it."
          : undefined,
    };
  }
  async review(
    ctx: AccessContext,
    id: string,
    reviewer: (operation: string, payload: unknown) => Promise<boolean>,
  ) {
    const before = this.load(ctx, id);
    if (before.state !== "pending") return this.status(ctx, id);
    const decision = await reviewer(before.operation, await this.open(before));
    this.load(ctx, id); // Re-check the expiry/permission after the user responds.
    if (
      !this.state.compareAndSet(`approval:${id}`, before, {
        ...before,
        state: decision ? "approved" : "rejected",
        ciphertext: decision ? before.ciphertext : "",
      })
    )
      throw new AppError(
        "STALE_REVISION",
        "Approval changed while being reviewed.",
      );
    return this.status(ctx, id);
  }
  async execute<T>(
    ctx: AccessContext,
    id: string,
    operation: string,
    run: (payload: unknown) => Promise<T>,
  ) {
    const before = this.load(ctx, id);
    if (before.operation !== operation)
      throw new AppError(
        "PERMISSION_DENIED",
        "Approval is for a different operation.",
      );
    if (before.state === "executed")
      return {
        status: "executed",
        replayed: true,
        receipt: before.receipt as T,
      };
    if (before.state !== "approved")
      throw new AppError(
        before.state === "pending" ? "APPROVAL_REQUIRED" : "OUTCOME_UNKNOWN",
        "This action is not available for execution.",
        "Inspect its trusted approval and receipt; never resubmit uncertain sends.",
      );
    const payload = await this.open(before);
    ctx.signal.throwIfAborted();
    authorize(ctx, this.identity, before.capability); // Re-check current policy after private-key access.
    const released: Action = { ...before, state: "released" };
    if (!this.state.compareAndSet(`approval:${id}`, before, released))
      throw new AppError(
        "OUTCOME_UNKNOWN",
        "Another caller may have released this action.",
      );
    try {
      const receipt = await run(payload);
      this.state.compareAndSet(`approval:${id}`, released, {
        ...released,
        state: "executed",
        receipt,
        ciphertext: "",
      });
      return { status: "executed", replayed: false, receipt };
    } catch (e) {
      this.state.compareAndSet(`approval:${id}`, released, {
        ...released,
        state: "unknown",
      });
      throw new AppError(
        "OUTCOME_UNKNOWN",
        "Execution has no definite receipt.",
        "Inspect the upstream state; do not send again.",
        false,
        "outcome_unknown",
      );
    }
  }
}
