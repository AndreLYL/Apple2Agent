import { randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";
import type { Config } from "../src/core/config.js";
import { allCapabilities, type AccessContext } from "../src/core/context.js";
import { References } from "../src/core/references.js";
import { SQLiteOperationStore } from "../src/core/operations.js";
import type {
  Calendar,
  CalendarAdapter,
  CalendarObject,
} from "../src/adapters/caldav.js";
import type { MailAdapter, Message, MailRef } from "../src/adapters/imap.js";
import { parseMessage } from "../src/adapters/imap.js";
import { CalendarService } from "../src/services/calendar.js";
import { MailService } from "../src/services/mail.js";
import { AppError } from "../src/core/errors.js";
export function config(): Config {
  return {
    version: 1,
    owner_id: randomUUID(),
    account_id: randomUUID(),
    credential_ref: randomUUID(),
    ref_key: "a".repeat(44),
    apple_account: "test@example.com",
    imap_username: "test@example.com",
    caldav_username: "test@example.com",
    sender_address: "test@example.com",
    caldav_base_url: "https://caldav.icloud.com/",
    imap_host: "imap.mail.me.com",
    imap_port: 993,
    default_timezone: "Asia/Tokyo",
    writable_calendar_ids: [],
  };
}
export class FakeCalendar implements CalendarAdapter {
  data = new Map<string, string>();
  writes = 0;
  loseReply = false;
  readFails = 0;
  delay = 0;
  async list(): Promise<Calendar[]> {
    return [
      {
        url: "https://caldav.icloud.com/home/personal/",
        name: "Personal",
        writable: true,
      },
      {
        url: "https://caldav.icloud.com/home/shared/",
        name: "Read only",
        writable: false,
      },
    ];
  }
  async objects() {
    return [...this.data].map(([url, data]) => ({ url, data }));
  }
  async put(ctx: AccessContext, url: string, data: string) {
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    ctx.signal.throwIfAborted();
    if (!this.data.has(url)) {
      this.writes++;
      this.data.set(url, data);
    }
    if (this.loseReply) {
      this.loseReply = false;
      throw new AppError("NETWORK_ERROR", "lost reply");
    }
  }
  async get(
    _ctx: AccessContext,
    url: string,
  ): Promise<CalendarObject | undefined> {
    if (this.readFails-- > 0) throw new Error("offline");
    const data = this.data.get(url);
    return data ? { url, data } : undefined;
  }
}
export class FakeMail implements MailAdapter {
  messages = new Map<number, Message>();
  appends = 0;
  uv = "11";
  loseReply = false;
  flagChanges = 0;
  async folders() {
    return [
      { path: "草稿", name: "草稿", special_use: "\\Drafts", selectable: true },
      {
        path: "INBOX",
        name: "Inbox",
        special_use: "\\Inbox",
        selectable: true,
      },
    ];
  }
  async search(_ctx: AccessContext, folder: string, _query: unknown) {
    return {
      uidvalidity: this.uv,
      uids: [...this.messages]
        .filter(([, m]) => m.ref.folder === folder)
        .map(([id]) => id)
        .sort((a, b) => b - a),
    };
  }
  async summaries(
    _ctx: AccessContext,
    _folder: string,
    uv: string,
    uids: number[],
  ) {
    if (uv !== this.uv) throw new AppError("STALE_REFERENCE", "changed");
    return uids.map((id) => this.messages.get(id)!);
  }
  async read(_ctx: AccessContext, ref: MailRef, max: number) {
    if (ref.uidvalidity !== this.uv)
      throw new AppError("STALE_REFERENCE", "changed");
    const m = this.messages.get(ref.uid);
    if (!m || m.ref.folder !== ref.folder)
      throw new AppError("NOT_FOUND", "missing");
    return {
      ...m,
      body_text: m.body_text.slice(0, max),
      truncated: m.body_text.length > max,
    };
  }
  async append(_ctx: AccessContext, folder: string, raw: Buffer) {
    this.appends++;
    const p = await simpleParser(raw);
    const parsed = await parseMessage(raw, 100000);
    const id = this.messages.size + 1;
    const addresses = (a: any) => a?.value ?? [];
    this.messages.set(id, {
      ref: { uid: id, uidvalidity: this.uv, folder },
      subject: p.subject ?? "",
      from: addresses(p.from),
      to: addresses(p.to),
      cc: addresses(p.cc),
      unread: true,
      ...parsed,
      draft: true,
    });
    if (this.loseReply) {
      this.loseReply = false;
      throw new AppError("NETWORK_ERROR", "lost append reply");
    }
  }
  async find(_ctx: AccessContext, folder: string, id: string) {
    return [...this.messages.values()].find(
      (m) => m.ref.folder === folder && m.message_id === id,
    );
  }
}
export function fixture(path = ":memory:") {
  const cfg = config();
  const refs = new References(cfg, cfg.ref_key);
  const operations = new SQLiteOperationStore(path);
  const cal = new FakeCalendar();
  const imap = new FakeMail();
  const calendarID = refs.encode(
    "calendar",
    "https://caldav.icloud.com/home/personal/",
  );
  cfg.default_calendar_id = calendarID;
  cfg.writable_calendar_ids = [calendarID];
  const ctx: AccessContext = {
    ...cfg,
    actor_id: "client-a",
    capabilities: new Set(allCapabilities),
    signal: AbortSignal.timeout(30000),
  };
  return {
    cfg,
    refs,
    operations,
    cal,
    imap,
    ctx,
    calendar: new CalendarService(cfg, cal, refs, operations),
    mail: new MailService(cfg, imap, refs, operations),
  };
}
export function eventInput() {
  return {
    title: "面试 / interview",
    start: "2026-11-14T10:00:00+09:00",
    end: "2026-11-14T10:30:00+09:00",
    timezone: "Asia/Tokyo",
    location: "Tokyo",
    notes: "line one\nline two",
    request_id: randomUUID(),
  };
}
