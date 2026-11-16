import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { SearchObject } from "imapflow";
import type { Config } from "../core/config.js";
import {
  authorize,
  requireGrant,
  type AccessContext,
} from "../core/context.js";
import { References, hash } from "../core/references.js";
import { schemas, type Args } from "../core/schemas.js";
import type { MailAdapter, MailRef, MailSummary } from "../adapters/imap.js";
import { executeWrite, type OperationStore } from "../core/operations.js";
import { AppError, invalid } from "../core/errors.js";
export class MailService {
  constructor(
    private config: Config,
    private adapter: MailAdapter,
    private refs: References,
    private operations: OperationStore,
  ) {}
  private view<T extends MailSummary>(message: T) {
    const { ref, ...fields } = message;
    return {
      ...fields,
      message_ref: this.refs.encode("message", ref),
      content_is_untrusted: true,
    };
  }
  async folders(ctx: AccessContext) {
    authorize(ctx, this.config, "mail:read");
    if (this.config.hub?.mail_accounts)
      requireGrant(ctx, "mail_accounts", "icloud:primary");
    return {
      folders: (await this.adapter.folders(ctx)).map((f) => ({
        ...f,
        folder_id: this.refs.encode("folder", f.path),
      })),
    };
  }
  async search(ctx: AccessContext, raw: Args<"mail_search">) {
    authorize(ctx, this.config, "mail:read");
    if (this.config.hub?.mail_accounts)
      requireGrant(ctx, "mail_accounts", "icloud:primary");
    const input = schemas.mail_search.parse(raw);
    if (
      input.since_date &&
      input.before_date &&
      input.since_date >= input.before_date
    )
      invalid("before_date must be later than since_date.");
    const folder = input.folder_id
      ? this.refs.decode<string>("folder", input.folder_id)
      : "INBOX";
    const query: SearchObject = { all: true };
    for (const key of ["from", "subject", "text"] as const)
      if (input[key]) query[key] = input[key];
    if (input.unread !== undefined) query.seen = !input.unread;
    if (input.since_date) query.since = input.since_date;
    if (input.before_date) query.before = input.before_date;
    const found = await this.adapter.search(ctx, folder, query);
    const { cursor, limit, ...conditions } = input;
    const page = this.refs.page(
      found.uids,
      { conditions, folder, uv: found.uidvalidity },
      limit,
      cursor,
    );
    const summaries = await this.adapter.summaries(
      ctx,
      folder,
      found.uidvalidity,
      page.items,
    );
    return {
      messages: summaries.map((m) => this.view(m)),
      next_cursor: page.next_cursor,
      order: "uid_desc",
      warnings:
        summaries.length !== page.items.length
          ? ["Some messages disappeared during the query."]
          : [],
      content_is_untrusted: true,
    };
  }
  async read(ctx: AccessContext, raw: Args<"mail_read">) {
    authorize(ctx, this.config, "mail:read");
    if (this.config.hub?.mail_accounts)
      requireGrant(ctx, "mail_accounts", "icloud:primary");
    const input = schemas.mail_read.parse(raw);
    const ref = this.refs.decode<MailRef>("message", input.message_ref);
    return this.view(await this.adapter.read(ctx, ref, input.max_chars));
  }
  async draft(ctx: AccessContext, raw: Args<"mail_draft_create">) {
    authorize(ctx, this.config, "mail:draft:create");
    if (this.config.hub?.mail_accounts)
      requireGrant(ctx, "mail_accounts", "icloud:primary");
    const input = schemas.mail_draft_create.parse(raw);
    if (!this.config.sender_address)
      throw new AppError(
        "NOT_CONFIGURED",
        "No iCloud mailbox sender configured.",
        "Enable iCloud Mail and configure its address.",
      );
    const messageId = `<a2a-${hash([this.config.owner_id, this.config.account_id, input.request_id])}@apple2agent.local>`;
    // Folder discovery is read-only and required even when recovering an uncertain APPEND.
    const folders = await this.adapter.folders(ctx);
    const candidates = this.config.drafts_folder
      ? folders.filter((f) => f.path === this.config.drafts_folder)
      : folders.filter((f) => f.special_use === "\\Drafts");
    if (candidates.length !== 1 || !candidates[0]!.selectable)
      throw new AppError(
        "DRAFTS_FOLDER_UNRESOLVED",
        "Cannot uniquely resolve the server Drafts folder.",
        "Set drafts_folder to a discovered Drafts folder in local configuration.",
      );
    const folder = candidates[0]!.path;
    const { request_id, ...payload } = input;
    let rawMessage: Buffer;
    const normalize = (s: string) =>
      s.replace(/\r\n/g, "\n").replace(/\n$/, "");
    const addresses = (items: unknown) =>
      Array.isArray(items)
        ? items.map((x) => String(x.address ?? "").toLowerCase()).sort()
        : [];
    const result = await executeWrite(
      this.operations,
      ctx,
      "mail_draft_create",
      request_id,
      { ...payload, folder },
      {
        prepare: async () => {
          rawMessage = await new MailComposer({
            from: this.config.sender_address,
            to: input.to ?? [],
            cc: input.cc ?? [],
            subject: input.subject,
            text: input.body_text,
            messageId,
            disableFileAccess: true,
            disableUrlAccess: true,
          })
            .compile()
            .build();
        },
        write: async () => this.adapter.append(ctx, folder, rawMessage),
        verify: async () => {
          const found = await this.adapter.find(ctx, folder, messageId);
          if (!found) return undefined;
          if (
            found.message_id !== messageId ||
            !found.draft ||
            found.subject !== input.subject ||
            normalize(found.body_text) !== normalize(input.body_text) ||
            JSON.stringify(addresses(found.to)) !==
              JSON.stringify(
                (input.to ?? []).map((x) => x.toLowerCase()).sort(),
              ) ||
            JSON.stringify(addresses(found.cc)) !==
              JSON.stringify(
                (input.cc ?? []).map((x) => x.toLowerCase()).sort(),
              ) ||
            !addresses(found.from).includes(
              this.config.sender_address.toLowerCase(),
            )
          )
            throw new AppError(
              "REQUEST_CONFLICT",
              "Stored draft differs from the requested content.",
              "Inspect the draft; no duplicate will be added.",
            );
          return {
            message_ref: this.refs.encode("message", found.ref),
            message_id: messageId,
            folder_id: this.refs.encode("folder", folder),
          };
        },
      },
    );
    return {
      ...result,
      request_id,
      message_id: messageId,
      folder_id: this.refs.encode("folder", folder),
      sent: false,
    };
  }
}
