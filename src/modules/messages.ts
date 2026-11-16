import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../core/config.js";
import {
  authorize,
  requireGrant,
  type AccessContext,
} from "../core/context.js";
import type { NativeBridge } from "../core/native.js";
import { References, hash } from "../core/references.js";
import { ApprovalStore } from "../core/approvals.js";
import { AppError } from "../core/errors.js";
import type { Module, ToolRegistry } from "./types.js";
const id = z.string().min(1).max(16384),
  epoch = Date.UTC(2001, 0, 1);
export function decodeAttributedBody(body: Uint8Array | undefined) {
  if (!body || body.byteLength > 1048576) return undefined;
  const b = Buffer.from(body),
    i = b.indexOf("NSString");
  if (i < 0) return undefined;
  const j = b.indexOf("+", i + 8);
  if (j < 0 || j > i + 16 || j + 1 >= b.length) return undefined;
  let k = j + 1,
    n = b[k]!,
    start = k + 1;
  try {
    if (n === 0x81) {
      n = b.readUInt16LE(k + 1);
      start = k + 3;
    } else if (n === 0x82) {
      n = b.readUInt32LE(k + 1);
      start = k + 5;
    } else if (n === 0x83) {
      const v = b.readBigUInt64LE(k + 1);
      if (v > 1048576n) return undefined;
      n = Number(v);
      start = k + 9;
    }
    if (n > 1048576 || start + n > b.length) return undefined;
    return new TextDecoder("utf-8", { fatal: true }).decode(
      b.subarray(start, start + n),
    );
  } catch {
    return undefined;
  }
}
export function normalizeHandle(s: string) {
  const v = s.trim();
  if (v.includes("@")) return v.toLowerCase();
  if (/^\+[1-9][\d ()-]{5,20}$/.test(v))
    return "+" + v.slice(1).replace(/\D/g, "");
  throw new AppError(
    "INVALID_INPUT",
    "Use an exact email or full international phone number.",
  );
}
export class MessagesModule implements Module {
  domain = "messages" as const;
  tools: ToolRegistry = {};
  constructor(
    private config: Config,
    private native: NativeBridge,
    private refs: References,
    private approvals: ApprovalStore,
    private dbPath = join(homedir(), "Library", "Messages", "chat.db"),
  ) {
    const add = (name: string, schema: z.ZodType, op: string, send = false) =>
      (this.tools[name] = {
        schema,
        capability: send ? "messages:send" : "messages:read",
        description: `${op} in this Mac user's explicitly selected Messages chats. SMS must already be synced; sending is iMessage only. Sends freeze exact participants and text for native review, never fall back to SMS or another chat. Missing/unsupported history is explicit.`,
        run: (ctx, a) => this.run(ctx, op, a, send),
      });
    add(
      "imessage_list_chats",
      z
        .object({ limit: z.number().int().min(1).max(100).default(50) })
        .strict(),
      "chats",
    );
    add(
      "imessage_read_chat",
      z
        .object({
          chat_id: id,
          since: z.iso.datetime({ offset: true }),
          before: z.iso.datetime({ offset: true }),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .strict(),
      "read",
    );
    add(
      "imessage_search_messages",
      z
        .object({
          chat_id: id,
          query: z.string().min(1).max(500),
          since: z.iso.datetime({ offset: true }),
          before: z.iso.datetime({ offset: true }),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict(),
      "search",
    );
    add(
      "imessage_send_message",
      z
        .object({
          chat_id: id,
          text: z.string().min(1).max(20000),
          request_id: z.uuid(),
        })
        .strict(),
      "prepare",
      true,
    );
    add(
      "imessage_execute_send",
      z.object({ action_id: id }).strict(),
      "execute",
      true,
    );
  }
  private db() {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true, timeout: 3000 });
      db.exec("PRAGMA query_only=ON");
    } catch {
      throw new AppError(
        "PERMISSION_DENIED",
        "Messages history is unavailable to this process.",
        "Grant Full Disk Access to the actual background host; do not copy another user’s database.",
      );
    }
    try {
      for (const [table, cols] of Object.entries({
        chat: ["guid", "display_name", "service_name"],
        message: ["guid", "text", "date", "is_from_me", "service"],
        chat_message_join: ["chat_id", "message_id"],
        handle: ["id"],
        chat_handle_join: ["chat_id", "handle_id"],
      })) {
        const found = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(
            (r) => r.name,
          ),
        );
        if (cols.some((c) => !found.has(c))) throw new Error();
      }
      return db;
    } catch {
      db.close();
      throw new AppError(
        "SCHEMA_UNSUPPORTED",
        "This Messages database schema is not supported.",
      );
    }
  }
  private chats(db: DatabaseSync, ctx: AccessContext) {
    const rows = db
      .prepare("SELECT ROWID AS rowid,guid,display_name,service_name FROM chat")
      .all() as any[];
    return rows
      .filter((r) => ctx.grants?.message_chats?.includes(r.guid))
      .map((r) => ({
        ...r,
        participants: (
          db
            .prepare(
              "SELECT h.id FROM handle h JOIN chat_handle_join j ON j.handle_id=h.ROWID WHERE j.chat_id=?",
            )
            .all(r.rowid) as any[]
        )
          .map((x) => x.id)
          .sort(),
      }));
  }
  async status(ctx: AccessContext) {
    authorize(ctx, this.config, "messages:read");
    const db = this.db();
    try {
      return {
        status: "ready",
        authorized_chats: this.chats(db, ctx).length,
        sms_scope: "only messages already synced to this Mac",
        send_service: "iMessage only",
      };
    } finally {
      db.close();
    }
  }
  private async run(
    ctx: AccessContext,
    op: string,
    a: any,
    send: boolean,
  ): Promise<any> {
    authorize(ctx, this.config, send ? "messages:send" : "messages:read");
    if (op === "execute")
      return this.approvals.execute(
        ctx,
        a.action_id,
        "imessage_send",
        async (payload) => {
          const p = payload as any;
          requireGrant(ctx, "message_chats", p.guid);
          this.checkRecipients(ctx, p.handles);
          const db = this.db();
          try {
            const current = this.chats(db, ctx).find((c) => c.guid === p.guid);
            if (
              !current ||
              current.service_name !== "iMessage" ||
              hash(current.participants) !== hash(p.handles)
            )
              throw new AppError("STALE_REVISION", "Chat identity changed.");
          } finally {
            db.close();
          }
          return this.native.call(ctx, "automation", "imessage_send", p);
        },
      );
    const db = this.db();
    try {
      const chats = this.chats(db, ctx);
      if (op === "chats")
        return {
          chats: chats.slice(0, a.limit).map((c) => ({
            chat_id: this.refs.encode("message-chat", { guid: c.guid }),
            name: c.display_name,
            service: c.service_name,
            participants: c.participants,
          })),
          complete: chats.length <= a.limit,
          sms_scope: "this Mac’s synced history only",
        };
      const guid = this.refs.decode<any>("message-chat", a.chat_id).guid;
      requireGrant(ctx, "message_chats", guid);
      const chat = chats.find((c) => c.guid === guid);
      if (!chat)
        throw new AppError("STALE_REFERENCE", "Chat is no longer available.");
      if (op === "prepare") {
        if (chat.service_name !== "iMessage")
          throw new AppError(
            "SERVICE_UNSUPPORTED",
            "This chat is not an iMessage chat; no SMS fallback.",
          );
        this.checkRecipients(ctx, chat.participants);
        return this.approvals.request(
          ctx,
          "imessage_send",
          a.request_id,
          "messages:send",
          {
            guid,
            handles: chat.participants,
            text: a.text,
            backend: "messages-apple-events",
            authorization_grants: [
              { kind: "message_chats", id: guid },
              ...chat.participants.map((id: string) => ({
                kind: "message_recipients",
                id,
              })),
            ],
          },
        );
      }
      const from = Date.parse(a.since),
        to = Date.parse(a.before);
      if (!(from < to) || to - from > 366 * 86400000)
        throw new AppError(
          "INVALID_INPUT",
          "Messages window must be between 0 and 366 days.",
        );
      const columns = new Set(
        (db.prepare("PRAGMA table_info(message)").all() as any[]).map(
          (r) => r.name,
        ),
      );
      const optional = [
        "attributedBody",
        "date_read",
        "date_delivered",
        "error",
        "associated_message_type",
        "associated_message_guid",
        "is_system_message",
        "is_spam",
        "date_retracted",
        "is_empty",
      ]
        .map((c) => (columns.has(c) ? `m.${c}` : `NULL AS ${c}`))
        .join(",");
      const statement = db.prepare(
        `SELECT m.ROWID AS rowid,m.guid,m.text,m.date,m.is_from_me,m.service,${optional} FROM message m JOIN chat_message_join j ON j.message_id=m.ROWID WHERE j.chat_id=? AND ((m.date>=? AND m.date<?) OR (abs(m.date)<100000000000 AND m.date>=? AND m.date<?)) ORDER BY m.date DESC,m.ROWID DESC LIMIT 2001`,
      );
      statement.setReadBigInts(true);
      const rows = statement.all(
        chat.rowid,
        BigInt(from - epoch) * 1000000n,
        BigInt(to - epoch) * 1000000n,
        (from - epoch) / 1000,
        (to - epoch) / 1000,
      ) as any[];
      let undecoded = 0;
      const reactions: Record<string, any[]> = {};
      const messages = rows
        .slice(0, 2000)
        .filter((r) => {
          if (
            r.associated_message_type >= 2000 &&
            r.associated_message_type < 4000
          ) {
            const target = String(r.associated_message_guid ?? "")
              .split("/")
              .at(-1)!;
            (reactions[target] ??= []).push({
              type: Number(r.associated_message_type),
              from_me: !!r.is_from_me,
            });
            return false;
          }
          return !r.is_system_message && !r.is_spam && !r.date_retracted;
        })
        .map((r) => {
          const text = r.text || decodeAttributedBody(r.attributedBody);
          if (text === undefined) undecoded++;
          return {
            id: r.guid,
            rowid: Number(r.rowid),
            text: text ?? null,
            body_supported: text !== undefined,
            from_me: !!r.is_from_me,
            service: r.service,
            date: new Date(
              epoch +
                (Math.abs(Number(r.date)) > 1e11
                  ? Number(r.date) / 1e6
                  : Number(r.date) * 1000),
            ).toISOString(),
            delivered_at: r.date_delivered
              ? new Date(epoch + Number(r.date_delivered) / 1e6).toISOString()
              : undefined,
            read_at: r.date_read
              ? new Date(epoch + Number(r.date_read) / 1e6).toISOString()
              : undefined,
            error: r.error ? Number(r.error) : undefined,
          };
        })
        .filter(
          (r) =>
            op !== "search" ||
            r.text?.toLowerCase().includes(a.query.toLowerCase()),
        );
      const attachmentMetadata = new Map<number, unknown[]>();
      let attachmentMetadataSupported = false;
      const attachmentColumns = new Set(
        (db.prepare("PRAGMA table_info(attachment)").all() as any[]).map(
          (x) => x.name,
        ),
      );
      const joinColumns = new Set(
        (
          db
            .prepare("PRAGMA table_info(message_attachment_join)")
            .all() as any[]
        ).map((x) => x.name),
      );
      if (
        ["transfer_name", "mime_type", "total_bytes"].every((c) =>
          attachmentColumns.has(c),
        ) &&
        ["message_id", "attachment_id"].every((c) => joinColumns.has(c))
      ) {
        attachmentMetadataSupported = true;
        const query = db.prepare(
          "SELECT a.transfer_name AS name,a.mime_type AS content_type,a.total_bytes AS size FROM attachment a JOIN message_attachment_join j ON j.attachment_id=a.ROWID WHERE j.message_id=? LIMIT 100",
        );
        for (const row of messages.slice(0, a.limit))
          attachmentMetadata.set(row.rowid, query.all(row.rowid));
      }
      const result = messages.slice(0, a.limit).map((r) => ({
        ...r,
        reactions: reactions[r.id] ?? [],
        attachments: attachmentMetadata.get(r.rowid) ?? [],
      }));
      return {
        chat: {
          chat_id: a.chat_id,
          service: chat.service_name,
          participants: chat.participants,
        },
        messages: result.reverse(),
        complete:
          rows.length <= 2000 && messages.length <= a.limit && undecoded === 0,
        scanned: Math.min(rows.length, 2000),
        unsupported_bodies: undecoded,
        scope: { since: a.since, before: a.before },
        attachment_content_supported: false,
        attachment_metadata_supported: attachmentMetadataSupported,
      };
    } finally {
      db.close();
    }
  }
  private checkRecipients(ctx: AccessContext, handles: string[]) {
    if (!handles.length)
      throw new AppError(
        "SERVICE_UNSUPPORTED",
        "Cannot verify empty participants.",
      );
    const never = this.config.hub?.message_never_send ?? [];
    for (const h of handles) {
      const exact = normalizeHandle(h);
      if (
        never.map(normalizeHandle).includes(exact) ||
        !ctx.grants?.message_recipients?.map(normalizeHandle).includes(exact)
      )
        throw new AppError(
          "PERMISSION_DENIED",
          "A participant is outside the recipient allowlist or on the never-send list.",
        );
    }
  }
}
