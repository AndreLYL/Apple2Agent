import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { AppError } from "./errors.js";
import type { Identity } from "./context.js";
export function hash(value: unknown) {
  return createHash("sha256").update(stableJSON(value)).digest("hex");
}
export function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJSON).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stableJSON(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export class References {
  private identity: Identity;
  constructor(
    identity: Identity,
    private key: string,
  ) {
    // Do not spread a structurally-compatible Config into public references.
    this.identity = {
      owner_id: identity.owner_id,
      account_id: identity.account_id,
    };
  }
  encode(kind: string, data: unknown) {
    const body = Buffer.from(
      JSON.stringify({ v: 1, ...this.identity, kind, data }),
    ).toString("base64url");
    return `a2a1.${body}.${createHmac("sha256", this.key).update(body).digest("base64url")}`;
  }
  decode<T>(kind: string, token: string): T {
    try {
      if (token.length > 16384) throw new Error();
      const [version, body, signature, extra] = token.split(".");
      if (version !== "a2a1" || !body || !signature || extra) throw new Error();
      const expected = createHmac("sha256", this.key).update(body).digest();
      const actual = Buffer.from(signature, "base64url");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error();
      const payload = JSON.parse(Buffer.from(body, "base64url").toString());
      if (
        payload.v !== 1 ||
        payload.kind !== kind ||
        payload.owner_id !== this.identity.owner_id ||
        payload.account_id !== this.identity.account_id
      )
        throw new Error();
      return payload.data as T;
    } catch {
      throw new AppError(
        "STALE_REFERENCE",
        "Invalid or out-of-scope resource reference.",
        "List or search again using this account.",
      );
    }
  }
  page<T>(items: T[], query: unknown, limit: number, cursor?: string) {
    const fingerprint = hash({ query, items });
    let offset = 0;
    if (cursor) {
      const state = this.decode<{
        fingerprint: string;
        offset: number;
        expires: number;
      }>("cursor", cursor);
      if (
        state.fingerprint !== fingerprint ||
        state.expires < Date.now() ||
        !Number.isSafeInteger(state.offset) ||
        state.offset < 0
      )
        throw new AppError(
          "STALE_REFERENCE",
          "The result set or query changed.",
          "Restart the query without a cursor.",
        );
      offset = state.offset;
    }
    const page = items.slice(offset, offset + limit);
    return {
      items: page,
      next_cursor:
        offset + limit < items.length
          ? this.encode("cursor", {
              fingerprint,
              offset: offset + limit,
              expires: Date.now() + 900000,
            })
          : null,
    };
  }
}
