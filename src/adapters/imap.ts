import { ImapFlow } from "imapflow";
import type { SearchObject, FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { convert } from "html-to-text";
import type { Config } from "../core/config.js";
import type { CredentialStore } from "../core/credentials.js";
import type { AccessContext } from "../core/context.js";
import { AppError, safeError } from "../core/errors.js";
export interface Folder {
  path: string;
  name: string;
  special_use?: string;
  selectable: boolean;
}
export interface MailRef {
  folder: string;
  uidvalidity: string;
  uid: number;
}
export interface MailSummary {
  ref: MailRef;
  subject: string;
  from: unknown;
  to: unknown;
  cc?: unknown;
  date?: string;
  unread: boolean;
}
export interface Message extends MailSummary {
  message_id?: string;
  body_text: string;
  truncated: boolean;
  attachments: { filename?: string; content_type: string; size: number }[];
  draft: boolean;
}
export interface MailAdapter {
  folders(ctx: AccessContext): Promise<Folder[]>;
  search(
    ctx: AccessContext,
    folder: string,
    query: SearchObject,
  ): Promise<{ uidvalidity: string; uids: number[] }>;
  summaries(
    ctx: AccessContext,
    folder: string,
    uidvalidity: string,
    uids: number[],
  ): Promise<MailSummary[]>;
  read(ctx: AccessContext, ref: MailRef, maxChars: number): Promise<Message>;
  append(ctx: AccessContext, folder: string, raw: Buffer): Promise<void>;
  find(
    ctx: AccessContext,
    folder: string,
    messageId: string,
  ): Promise<Message | undefined>;
}
export async function parseMessage(
  source: Buffer,
  maxChars: number,
  sourceTruncated = false,
) {
  const parsed = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  const body =
    parsed.text ||
    (typeof parsed.html === "string"
      ? convert(parsed.html, {
          wordwrap: false,
          limits: { maxInputLength: 2 * 1024 * 1024 },
          selectors: [
            { selector: "img", format: "skip" },
            { selector: "a", options: { ignoreHref: true } },
          ],
        })
      : "");
  return {
    message_id: parsed.messageId,
    body_text: body.slice(0, maxChars),
    truncated: sourceTruncated || body.length > maxChars,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename,
      content_type: a.contentType,
      size: a.size,
    })),
  };
}
function summary(
  message: FetchMessageObject,
  folder: string,
  uidvalidity: string,
): MailSummary {
  const date = message.envelope?.date;
  const parsedDate = date ? new Date(date) : undefined;
  return {
    ref: { folder, uidvalidity, uid: message.uid },
    subject: message.envelope?.subject ?? "",
    from: message.envelope?.from ?? [],
    to: message.envelope?.to ?? [],
    cc: message.envelope?.cc ?? [],
    date:
      parsedDate && !Number.isNaN(parsedDate.valueOf())
        ? parsedDate.toISOString()
        : undefined,
    unread: !message.flags?.has("\\Seen"),
  };
}
export class IMAPAdapter implements MailAdapter {
  constructor(
    protected config: Config,
    protected credentials: CredentialStore,
    protected makeClient: (
      options: ConstructorParameters<typeof ImapFlow>[0],
    ) => ImapFlow = (options) => new ImapFlow(options),
    private explicitlyConfiguredHost = false,
  ) {}
  protected async using<T>(
    ctx: AccessContext,
    fn: (client: ImapFlow) => Promise<T>,
    write = false,
  ): Promise<T> {
    if (!this.config.imap_username)
      throw new AppError(
        "NOT_CONFIGURED",
        "An iCloud mailbox has not been configured.",
        "Create/enable iCloud Mail, then configure its actual mailbox address.",
      );
    if (
      !this.explicitlyConfiguredHost &&
      !/^(?:[a-z0-9-]+\.)*(?:mail\.me\.com|mail\.icloud\.com(?:\.cn)?)$/i.test(
        this.config.imap_host,
      )
    )
      throw new AppError(
        "ENDPOINT_UNSUPPORTED",
        "IMAP host is not an allowed iCloud server.",
        "Use a verified iCloud IMAP endpoint.",
      );
    const password = await this.credentials.get(
      this.config.credential_ref,
      ctx.signal,
    );
    const client = this.makeClient({
      host: this.config.imap_host,
      port: 993,
      secure: true,
      auth: { user: this.config.imap_username, pass: password },
      logger: false,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      disableAutoIdle: true,
    });
    client.on("error", () => {});
    const abort = () => client.close();
    ctx.signal.addEventListener("abort", abort, { once: true });
    let connected = false;
    try {
      ctx.signal.throwIfAborted();
      await client.connect();
      connected = true;
      return await fn(client);
    } catch (e) {
      const mapped = safeError(e);
      if (write && !connected) mapped.write_state = "failed_before_write";
      throw mapped;
    } finally {
      ctx.signal.removeEventListener("abort", abort);
      client.close();
    }
  }
  protected validity(client: ImapFlow) {
    return client.mailbox ? String(client.mailbox.uidValidity) : "";
  }
  protected async mailbox<T>(
    ctx: AccessContext,
    folder: string,
    expected: string | undefined,
    fn: (client: ImapFlow, validity: string) => Promise<T>,
  ) {
    return this.using(ctx, async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const validity = this.validity(client);
        if (!validity || (expected && validity !== expected))
          throw new AppError(
            "STALE_REFERENCE",
            "Mailbox UIDVALIDITY changed.",
            "Search again for a fresh message reference.",
          );
        return await fn(client, validity);
      } finally {
        lock.release();
      }
    });
  }
  async folders(ctx: AccessContext) {
    return this.using(ctx, async (client) =>
      (await client.list()).map((f) => ({
        path: f.path,
        name: f.name,
        special_use: f.specialUse,
        selectable: !f.flags.has("\\Noselect"),
      })),
    );
  }
  async search(ctx: AccessContext, folder: string, query: SearchObject) {
    return this.mailbox(ctx, folder, undefined, async (client, uidvalidity) => {
      const result = await client.search(query, { uid: true });
      if (!Array.isArray(result))
        throw new AppError(
          "NETWORK_ERROR",
          "IMAP could not complete the search.",
          "Narrow the query and retry.",
          true,
        );
      if (result.length > 100000)
        throw new AppError(
          "CONTENT_TOO_LARGE",
          "Search matched more than 100,000 messages.",
          "Add a date, sender, or subject filter.",
        );
      return { uidvalidity, uids: result.sort((a, b) => b - a) };
    });
  }
  async summaries(
    ctx: AccessContext,
    folder: string,
    validity: string,
    uids: number[],
  ) {
    if (!uids.length) return [];
    return this.mailbox(ctx, folder, validity, async (client, uv) => {
      const messages = await client.fetchAll(
        uids.join(","),
        { envelope: true, flags: true },
        { uid: true },
      );
      return messages
        .map((m) => summary(m, folder, uv))
        .sort((a, b) => b.ref.uid - a.ref.uid);
    });
  }
  async read(ctx: AccessContext, ref: MailRef, maxChars: number) {
    return this.mailbox(
      ctx,
      ref.folder,
      ref.uidvalidity,
      async (client, uv) => {
        const message = await client.fetchOne(
          ref.uid,
          {
            envelope: true,
            flags: true,
            size: true,
            source: { maxLength: 2 * 1024 * 1024 },
          },
          { uid: true },
        );
        if (!message || !message.source)
          throw new AppError(
            "NOT_FOUND",
            "The message is no longer available.",
            "Search again.",
          );
        const parsed = await parseMessage(
          message.source,
          maxChars,
          (message.size ?? 0) > message.source.length,
        );
        return {
          ...summary(message, ref.folder, uv),
          ...parsed,
          draft: message.flags?.has("\\Draft") ?? false,
        };
      },
    );
  }
  async append(ctx: AccessContext, folder: string, raw: Buffer) {
    await this.using(
      ctx,
      async (client) => {
        try {
          const result = await client.append(folder, raw, ["\\Draft"]);
          if (!result)
            throw new AppError(
              "PERMISSION_DENIED",
              "iCloud refused to save this draft.",
              "Check the configured Drafts folder.",
              false,
              "failed_before_write",
            );
        } catch (e) {
          if (e instanceof AppError) throw e;
          const code = (e as { serverResponseCode?: string })
            .serverResponseCode;
          if (
            code &&
            [
              "NOPERM",
              "OVERQUOTA",
              "APPENDLIMIT",
              "TRYCREATE",
              "CANNOT",
            ].includes(code)
          )
            throw new AppError(
              "PERMISSION_DENIED",
              "iCloud refused the draft append.",
              "Check folder permissions and quota.",
              false,
              "failed_before_write",
            );
          throw e;
        }
      },
      true,
    );
  }
  async find(ctx: AccessContext, folder: string, messageId: string) {
    const found = await this.search(ctx, folder, {
      header: { "Message-ID": messageId },
    });
    if (!found.uids.length) return undefined;
    if (found.uids.length !== 1)
      throw new AppError(
        "REQUEST_CONFLICT",
        "Multiple drafts share this operation Message-ID.",
        "Inspect the drafts manually; no further copy will be added.",
      );
    return this.read(
      ctx,
      { folder, uidvalidity: found.uidvalidity, uid: found.uids[0]! },
      100000,
    );
  }
}
