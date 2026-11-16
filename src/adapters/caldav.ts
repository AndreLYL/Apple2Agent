import { createDAVClient } from "tsdav";
import type { DAVCalendar } from "tsdav";
import { AppError, safeError } from "../core/errors.js";
import type { AccessContext } from "../core/context.js";
import type { Config } from "../core/config.js";
import type { CredentialStore } from "../core/credentials.js";
export interface Calendar {
  url: string;
  name: string;
  writable: boolean | null;
  timezone?: string;
}
export interface CalendarObject {
  url: string;
  data: string;
  etag?: string;
}
export interface CalendarAdapter {
  readonly supportsSilentDelete?: boolean;
  userAddresses?(ctx: AccessContext): Promise<string[]>;
  list(ctx: AccessContext): Promise<Calendar[]>;
  objects(
    ctx: AccessContext,
    calendar: Calendar,
    from: Date,
    to: Date,
  ): Promise<CalendarObject[]>;
  put(ctx: AccessContext, url: string, data: string): Promise<void>;
  get(ctx: AccessContext, url: string): Promise<CalendarObject | undefined>;
  update?(
    ctx: AccessContext,
    url: string,
    data: string,
    etag: string,
  ): Promise<void>;
  remove?(ctx: AccessContext, url: string, etag: string): Promise<void>;
}
export function isAppleDAV(url: URL) {
  return (
    url.protocol === "https:" &&
    (!url.port || url.port === "443") &&
    !url.username &&
    !url.password &&
    /^(?:[a-z0-9-]+\.)*icloud\.com(?:\.cn)?$/i.test(url.hostname)
  );
}
// All DAV library discovery requests go through this checked, bounded fetch.
export function guardedFetch(
  signal: AbortSignal,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    let url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!isAppleDAV(url))
        throw new AppError(
          "ENDPOINT_UNSUPPORTED",
          "Refusing a non-iCloud or non-TLS DAV endpoint.",
          "Configure a verified Apple iCloud HTTPS endpoint.",
        );
      const response = await baseFetch(url, {
        ...init,
        redirect: "manual",
        signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          throw new AppError(
            "ENDPOINT_UNSUPPORTED",
            "DAV returned an invalid redirect.",
            "Run doctor.",
          );
        url = new URL(location, url);
        continue;
      }
      if (response.status === 401)
        throw new AppError(
          "AUTH_FAILED",
          "CalDAV rejected the credentials.",
          "Check the calendar login and app-specific password.",
          false,
          "failed_before_write",
        );
      const reader = response.body?.getReader();
      if (!reader) return response;
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          size += r.value.length;
          if (size > 12 * 1024 * 1024)
            throw new AppError(
              "CONTENT_TOO_LARGE",
              "DAV response exceeded 12 MiB.",
              "Narrow the date range or choose one calendar.",
            );
          chunks.push(r.value);
        }
      } catch (e) {
        await reader.cancel().catch(() => {});
        throw e;
      }
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    throw new AppError(
      "ENDPOINT_UNSUPPORTED",
      "Too many DAV redirects.",
      "Check the configured endpoint.",
    );
  }) as typeof fetch;
}
function privilege(node: unknown, names: Set<string>): boolean {
  if (!node || typeof node !== "object") return false;
  return Object.entries(node).some(
    ([key, value]) =>
      names.has(key.split(":").at(-1)!) || privilege(value, names),
  );
}
export class CalDAVAdapter implements CalendarAdapter {
  readonly supportsSilentDelete = true;
  private clients = new WeakMap<
    AbortSignal,
    ReturnType<typeof createDAVClient>
  >();
  constructor(
    private config: Config,
    private credentials: CredentialStore,
  ) {}
  private async client(ctx: AccessContext) {
    let pending = this.clients.get(ctx.signal);
    if (!pending) {
      pending = this.connect(ctx);
      this.clients.set(ctx.signal, pending);
      void pending.catch(() => this.clients.delete(ctx.signal));
    }
    return pending;
  }
  private async connect(ctx: AccessContext) {
    try {
      return await createDAVClient({
        serverUrl: this.config.caldav_base_url,
        credentials: {
          username: this.config.caldav_username,
          password: await this.credentials.get(
            this.config.credential_ref,
            ctx.signal,
          ),
        },
        authMethod: "Basic",
        defaultAccountType: "caldav",
        fetch: guardedFetch(ctx.signal),
        fetchOptions: { signal: ctx.signal },
      });
    } catch (e) {
      throw safeError(e);
    }
  }
  async userAddresses(ctx: AccessContext) {
    const client = await this.client(ctx);
    const account = await client.createAccount({
      account: {
        accountType: "caldav",
        serverUrl: this.config.caldav_base_url,
      },
      loadCollections: false,
      loadObjects: false,
      fetch: guardedFetch(ctx.signal),
    });
    return client.fetchCalendarUserAddresses({
      account,
      fetch: guardedFetch(ctx.signal),
    });
  }
  async list(ctx: AccessContext): Promise<Calendar[]> {
    const client = await this.client(ctx);
    const raw = await client.fetchCalendars({
      props: {
        "d:displayname": {},
        "d:resourcetype": {},
        "c:supported-calendar-component-set": {},
        "c:calendar-timezone": {},
        "d:current-user-privilege-set": {},
      },
      projectedProps: { currentUserPrivilegeSet: true },
      fetch: guardedFetch(ctx.signal),
    });
    if (raw.length > 100)
      throw new AppError(
        "CONTENT_TOO_LARGE",
        "More than 100 calendars returned.",
        "Limit the account calendars before using this MVP.",
      );
    return raw
      .filter(
        (c) =>
          !c.components?.length || c.components.map(String).includes("VEVENT"),
      )
      .map((c) => {
        const p = c.projectedProps?.["currentUserPrivilegeSet"];
        return {
          url: c.url,
          name: typeof c.displayName === "string" ? c.displayName : "Calendar",
          writable: p ? privilege(p, new Set(["write", "bind"])) : null,
          timezone: (c as DAVCalendar & { timezone?: string }).timezone,
        };
      });
  }
  async objects(ctx: AccessContext, calendar: Calendar, from: Date, to: Date) {
    const client = await this.client(ctx);
    const raw = await client.fetchCalendarObjects({
      calendar: { url: calendar.url } as DAVCalendar,
      timeRange: { start: from.toISOString(), end: to.toISOString() },
      expand: true,
      fetch: guardedFetch(ctx.signal),
    });
    return raw.map((o) => ({
      url: o.url,
      data: String(o.data ?? ""),
      etag: o.etag,
    }));
  }
  private async request(
    ctx: AccessContext,
    url: string,
    method: string,
    body?: string,
    etag?: string,
    extraHeaders?: Record<string, string>,
  ) {
    const password = await this.credentials.get(
      this.config.credential_ref,
      ctx.signal,
    );
    return guardedFetch(ctx.signal)(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.config.caldav_username}:${password}`).toString("base64")}`,
        ...(body
          ? {
              "Content-Type": "text/calendar; charset=utf-8",
              ...(etag ? {} : { "If-None-Match": "*" }),
            }
          : {}),
        ...(etag ? { "If-Match": etag } : {}),
        ...extraHeaders,
      },
      body,
    });
  }
  async put(ctx: AccessContext, url: string, data: string) {
    const r = await this.request(ctx, url, "PUT", data);
    if ([409, 412].includes(r.status)) return; // Never replace: caller must verify the existing object.
    if (!r.ok)
      throw new AppError(
        r.status === 403 ? "PERMISSION_DENIED" : "NETWORK_ERROR",
        `CalDAV refused creation (HTTP ${r.status}).`,
        "Check the target calendar.",
        false,
        r.status >= 400 && r.status < 500 ? "failed_before_write" : undefined,
      );
  }
  async get(ctx: AccessContext, url: string) {
    const r = await this.request(ctx, url, "GET");
    if (r.status === 404) return undefined;
    if (!r.ok)
      throw new AppError(
        "NETWORK_ERROR",
        `CalDAV read failed (HTTP ${r.status}).`,
        "Run doctor.",
        true,
      );
    return {
      url,
      data: await r.text(),
      etag: r.headers.get("etag") ?? undefined,
    };
  }
  async update(ctx: AccessContext, url: string, data: string, etag: string) {
    const r = await this.request(ctx, url, "PUT", data, etag);
    this.checkMutation(r);
  }
  async remove(ctx: AccessContext, url: string, etag: string) {
    const r = await this.request(ctx, url, "DELETE", undefined, etag, {
      "Schedule-Reply": "F",
    });
    this.checkMutation(r);
  }
  private checkMutation(r: Response) {
    if (r.ok) return;
    throw new AppError(
      r.status === 412
        ? "STALE_REVISION"
        : r.status === 403
          ? "PERMISSION_DENIED"
          : r.status === 404
            ? "NOT_FOUND"
            : "NETWORK_ERROR",
      `CalDAV rejected the conditional write (HTTP ${r.status}).`,
      "Read the current event before retrying.",
      false,
      r.status >= 400 && r.status < 500 ? "failed_before_write" : undefined,
    );
  }
}
