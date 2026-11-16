import { createDAVClient } from "tsdav";
import type { Config } from "../core/config.js";
import type { CredentialStore } from "../core/credentials.js";
import type { AccessContext } from "../core/context.js";
import { guardedFetch } from "./caldav.js";
import { AppError } from "../core/errors.js";
export interface CardObject {
  url: string;
  etag?: string;
  data: string;
}
export interface CardProvider {
  books(ctx: AccessContext): Promise<{ url: string; name: string }[]>;
  cards(ctx: AccessContext, book: string): Promise<CardObject[]>;
  get(ctx: AccessContext, url: string): Promise<CardObject | undefined>;
  put(
    ctx: AccessContext,
    url: string,
    data: string,
    etag?: string,
  ): Promise<void>;
  remove(ctx: AccessContext, url: string, etag: string): Promise<void>;
}
// Some networks cannot reach an iCloud contacts shard even though Apple's
// authenticated contacts front door serves the same resource paths. Select one
// transport before a request; never retry a mutation against a second host.
export function cardDAVFetch(
  signal: AbortSignal,
  frontdoor: boolean,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  if (!frontdoor) return guardedFetch(signal, baseFetch);
  return guardedFetch(signal, (async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const match = /^p\d+-contacts\.(icloud\.com(?:\.cn)?)$/i.exec(url.hostname);
    if (match) url.hostname = `contacts.${match[1]!.toLowerCase()}`;
    return baseFetch(url, init);
  }) as typeof fetch);
}
export class CardDAVAdapter implements CardProvider {
  private clients = new WeakMap<
    AbortSignal,
    ReturnType<typeof createDAVClient>
  >();
  constructor(
    private config: Config,
    private credentials: CredentialStore,
  ) {}
  private fetch(ctx: AccessContext) {
    return cardDAVFetch(
      ctx.signal,
      this.config.hub?.contacts_transport === "frontdoor",
    );
  }
  private client(ctx: AccessContext) {
    let p = this.clients.get(ctx.signal);
    if (!p) {
      p = (async () =>
        createDAVClient({
          serverUrl:
            this.config.hub?.contacts_base_url ??
            "https://contacts.icloud.com/",
          credentials: {
            username: this.config.caldav_username,
            password: await this.credentials.get(
              this.config.credential_ref,
              ctx.signal,
            ),
          },
          authMethod: "Basic",
          defaultAccountType: "carddav",
          fetch: this.fetch(ctx),
        }))();
      this.clients.set(ctx.signal, p);
    }
    return p;
  }
  async books(ctx: AccessContext) {
    const r = await (
      await this.client(ctx)
    ).fetchAddressBooks({ fetch: this.fetch(ctx) });
    if (r.length > 100)
      throw new AppError("CONTENT_TOO_LARGE", "Too many address books.");
    return r.map((b) => ({
      url: b.url,
      name: String(b.displayName ?? "Contacts"),
    }));
  }
  async cards(ctx: AccessContext, book: string) {
    const r = await (
      await this.client(ctx)
    ).fetchVCards({
      addressBook: { url: book },
      fetch: this.fetch(ctx),
    });
    if (r.length > 5000)
      throw new AppError(
        "CONTENT_TOO_LARGE",
        "Address book exceeds the bounded snapshot.",
      );
    return r.map((c) => ({ url: c.url, data: String(c.data), etag: c.etag }));
  }
  private async request(
    ctx: AccessContext,
    url: string,
    method: string,
    data?: string,
    etag?: string,
  ) {
    const password = await this.credentials.get(
      this.config.credential_ref,
      ctx.signal,
    );
    const r = await this.fetch(ctx)(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.caldav_username}:${password}`).toString("base64")}`,
        ...(data ? { "Content-Type": "text/vcard; charset=utf-8" } : {}),
        ...(method === "PUT"
          ? etag
            ? { "If-Match": etag }
            : { "If-None-Match": "*" }
          : etag
            ? { "If-Match": etag }
            : {}),
      },
      body: data,
    });
    if (r.status === 404 && method === "GET") return r;
    if (!r.ok)
      throw new AppError(
        r.status === 412
          ? "STALE_REVISION"
          : r.status === 403
            ? "PERMISSION_DENIED"
            : "NETWORK_ERROR",
        "CardDAV rejected this request.",
        "Refresh the contact and its revision.",
        false,
        r.status >= 400 && r.status < 500 ? "failed_before_write" : undefined,
      );
    return r;
  }
  async get(ctx: AccessContext, url: string) {
    const r = await this.request(ctx, url, "GET");
    return r.status === 404
      ? undefined
      : { url, data: await r.text(), etag: r.headers.get("etag") ?? undefined };
  }
  async put(ctx: AccessContext, url: string, data: string, etag?: string) {
    await this.request(ctx, url, "PUT", data, etag);
  }
  async remove(ctx: AccessContext, url: string, etag: string) {
    await this.request(ctx, url, "DELETE", undefined, etag);
  }
}
