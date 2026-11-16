import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { config } from "./fixtures.js";
import { allCapabilities, type AccessContext } from "../src/core/context.js";
import { References, hash } from "../src/core/references.js";
import { HubState } from "../src/core/hub-state.js";
import { ApprovalStore } from "../src/core/approvals.js";
import { ProcessNativeBridge, type NativeBridge } from "../src/core/native.js";
import { AppError } from "../src/core/errors.js";
import { DriveModule } from "../src/modules/drive.js";
import { NotesModule } from "../src/modules/notes.js";
import { ContactsModule } from "../src/modules/contacts.js";
import { RemindersModule } from "../src/modules/reminders.js";
import {
  MessagesModule,
  decodeAttributedBody,
  normalizeHandle,
} from "../src/modules/messages.js";
import { MailModule } from "../src/modules/mail.js";
import { isPublicAddress } from "../src/core/public-https.js";
import { parseCard, value, serializeCard, line } from "../src/core/vcard.js";
import { createApplication } from "../src/app.js";
import type { CardProvider, CardObject } from "../src/adapters/carddav.js";
async function fixture() {
  const cfg = config(),
    dir = await mkdtemp(join(tmpdir(), "a2a-modules-")),
    state = new HubState(join(dir, "ops.sqlite")),
    refs = new References(cfg, cfg.ref_key);
  const ctx: AccessContext = {
    owner_id: cfg.owner_id,
    account_id: cfg.account_id,
    actor_id: "test",
    capabilities: new Set(allCapabilities),
    grants: {},
    signal: AbortSignal.timeout(30000),
  };
  const approvals = new ApprovalStore(state, cfg, async () => randomBytes(32));
  return { cfg, dir, state, refs, ctx, approvals };
}
async function run(m: any, name: string, ctx: AccessContext, a: any) {
  const t = m.tools[name];
  return t.run(ctx, t.schema.parse(a));
}
class Cards implements CardProvider {
  data = new Map<string, CardObject>();
  writes = 0;
  loses = 0;
  version = 0;
  book = "https://contacts.icloud.com/u/book/";
  async books() {
    return [{ url: this.book, name: "Test" }];
  }
  async cards() {
    return [...this.data.values()];
  }
  async get(_ctx: any, url: string) {
    return this.data.get(url);
  }
  async put(_ctx: any, url: string, data: string, etag?: string) {
    const old = this.data.get(url);
    if (etag ? old?.etag !== etag : !!old)
      throw new AppError(
        "STALE_REVISION",
        "changed",
        undefined,
        false,
        "failed_before_write",
      );
    this.writes++;
    this.data.set(url, { url, data, etag: `"${++this.version}"` });
    if (this.loses-- > 0) throw new Error("lost");
  }
  async remove(_ctx: any, url: string, etag: string) {
    if (this.data.get(url)?.etag !== etag)
      throw new AppError("STALE_REVISION", "changed");
    this.data.delete(url);
    this.writes++;
  }
}
test("CardDAV conditional CRUD, lost receipts, group separation and unknown-property preservation", async () => {
  const f = await fixture(),
    provider = new Cards();
  f.ctx.grants = { addressbooks: [provider.book] };
  const m = new ContactsModule(f.cfg, provider, f.refs, f.state),
    book = f.refs.encode("addressbook", provider.book);
  const input = {
    addressbook_id: book,
    name: "李测试",
    emails: [{ value: "a@example.com", label: "WORK" }],
    request_id: randomUUID(),
  };
  provider.loses = 1;
  await assert.rejects(run(m, "contacts_create_contact", f.ctx, input), {
    code: "OUTCOME_UNKNOWN",
  });
  const recovered = await run(m, "contacts_create_contact", f.ctx, input);
  assert.equal(recovered.verified, true);
  assert.equal(provider.writes, 1);
  const contact = await run(m, "contacts_get_contact", f.ctx, {
    id: recovered.resource.id,
  });
  const ref = f.refs.decode<any>("card", contact.id),
    current = provider.data.get(ref.url)!;
  current.data = current.data.replace(
    "END:VCARD",
    "PHOTO;ENCODING=b:YWJj\r\nNOTE:private note\r\nitem1.X-ABLabel:Custom\r\nEND:VCARD",
  );
  current.etag = '"external"';
  const read = await run(m, "contacts_get_contact", f.ctx, { id: contact.id });
  assert.equal("notes" in read, false);
  const patch = {
    id: contact.id,
    expected_revision: read.revision,
    phones: [{ value: "+819012345678", label: "CELL" }],
    request_id: randomUUID(),
  };
  const changed = await run(m, "contacts_update_contact", f.ctx, patch);
  assert.equal(changed.verified, true);
  assert.match(provider.data.get(ref.url)!.data, /PHOTO;ENCODING=b:YWJj/);
  assert.match(provider.data.get(ref.url)!.data, /NOTE:private note/);
  assert.equal(
    value(parseCard(provider.data.get(ref.url)!.data), "EMAIL"),
    "a@example.com",
  );
  assert.equal(
    (await run(m, "contacts_update_contact", f.ctx, patch)).replayed,
    true,
  );
  await assert.rejects(
    run(m, "contacts_update_contact", f.ctx, {
      ...patch,
      request_id: randomUUID(),
    }),
    { code: "STALE_REVISION" },
  );
  const group = await run(m, "contacts_create_group", f.ctx, {
    addressbook_id: book,
    name: "Group",
    members: [contact.id],
    request_id: randomUUID(),
  });
  const gr = await run(m, "contacts_get_group", f.ctx, {
    id: group.resource.id,
  });
  assert.equal(gr.members.length, 1);
  await run(m, "contacts_delete_group", f.ctx, {
    id: gr.id,
    expected_revision: gr.revision,
    request_id: randomUUID(),
  });
  assert.ok(await provider.get(null, ref.url));
  f.ctx.grants = { addressbooks: [] };
  await assert.rejects(run(m, "contacts_create_contact", f.ctx, input), {
    code: "PERMISSION_DENIED",
  });
  f.state.close();
});
test("native Drive helper confines paths, preserves UTF-8, refuses stale replacement and never overwrites move destinations", async () => {
  const f = await fixture(),
    root = join(f.dir, "root"),
    outside = join(f.dir, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(outside, join(root, "escape"));
  f.ctx.grants = { drive_roots: [root] };
  const m = new DriveModule(
      f.cfg,
      new ProcessNativeBridge(),
      f.refs,
      f.state,
      f.dir,
    ),
    root_id = f.refs.encode("drive-root", { path: root });
  const input = {
    root_id,
    path: "中文.md",
    text: "你好🌿".repeat(20000),
    request_id: randomUUID(),
  };
  const created = await run(m, "drive_write_file", f.ctx, input);
  assert.equal(created.verified, true);
  assert.equal((await run(m, "drive_write_file", f.ctx, input)).replayed, true);
  const r = await run(m, "drive_read_file", f.ctx, {
    root_id,
    path: "中文.md",
  });
  assert.equal(r.text, input.text);
  assert.equal(r.truncated, false);
  for (const path of [
    "../outside/secret.txt",
    "escape/secret.txt",
    "/etc/passwd",
  ])
    await assert.rejects(run(m, "drive_read_file", f.ctx, { root_id, path }), {
      code: "PERMISSION_DENIED",
    });
  const overwrite = {
    root_id,
    path: "中文.md",
    text: "new",
    overwrite: true,
    expected_revision: r.revision,
    request_id: randomUUID(),
  };
  await writeFile(join(root, "中文.md"), "external");
  await assert.rejects(run(m, "drive_write_file", f.ctx, overwrite), {
    code: "STALE_REVISION",
  });
  assert.equal(await readFile(join(root, "中文.md"), "utf8"), "external");
  await writeFile(join(root, "occupied.md"), "occupied");
  const now = await run(m, "drive_get_info", f.ctx, {
    root_id,
    path: "中文.md",
  });
  const moved = await run(m, "drive_move_item", f.ctx, {
    root_id,
    path: "中文.md",
    target: "next.md",
    expected_revision: now.revision,
    request_id: randomUUID(),
  });
  assert.equal(moved.verified, true);
  const movedInfo = await run(m, "drive_get_info", f.ctx, {
    root_id,
    path: "next.md",
  });
  await assert.rejects(
    run(m, "drive_move_item", f.ctx, {
      root_id,
      path: "next.md",
      target: "occupied.md",
      expected_revision: movedInfo.revision,
      request_id: randomUUID(),
    }),
  );
  assert.equal(await readFile(join(root, "occupied.md"), "utf8"), "occupied");
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside");
  f.state.close();
});
class FakeNotes implements NativeBridge {
  row: any = {
    id: "n1",
    folder_id: "f1",
    title: "Test",
    text: "original",
    modified: "1",
    native_hash: "h1",
    html: "<h1>Test</h1><div>original</div>",
    attachments: 0,
    has_table: false,
    locked: false,
    recently_deleted: false,
  };
  writes = 0;
  lose = false;
  async call<T>(
    _ctx: AccessContext,
    _helper: string,
    op: string,
    a: any,
  ): Promise<T> {
    if (!a.grants.folders.includes(this.row.folder_id))
      throw new AppError("PERMISSION_DENIED", "outside");
    if (op === "notes_read") return { ...this.row } as T;
    if (op === "notes_append" || op === "notes_rewrite") {
      if (a.expected_native_hash !== this.row.native_hash)
        throw new AppError("STALE_REVISION", "changed");
      this.writes++;
      this.row.text =
        op === "notes_append" ? this.row.text + "\n" + a.text : a.text;
      this.row.modified = String(this.writes + 1);
      this.row.native_hash = "h" + (this.writes + 1);
      if (this.lose) throw new Error("lost");
      return { ...this.row } as T;
    }
    throw new AppError("INVALID_INPUT", op);
  }
}
test("Notes compares full versions, backs up, replays once and rejects revoked, truncated or table edits", async () => {
  const f = await fixture(),
    native = new FakeNotes(),
    m = new NotesModule(f.cfg, native, f.refs, f.state, f.dir);
  f.ctx.grants = { notes_folders: ["f1"] };
  const id = f.refs.encode("note", { id: "n1", folder: "f1" }),
    read = await run(m, "notes_read_note", f.ctx, { id }),
    input = {
      id,
      title: "Test",
      content_hash: read.content_hash,
      text: "append",
      request_id: randomUUID(),
    };
  const result = await run(m, "notes_append_to_note", f.ctx, input);
  assert.equal(result.verified, true);
  assert.equal(
    (await run(m, "notes_append_to_note", f.ctx, input)).replayed,
    true,
  );
  assert.equal(native.writes, 1);
  assert.match(
    await readFile(
      join(f.dir, "backups", "notes", result.resource.backup_id + ".json"),
      "utf8",
    ),
    /original/,
  );
  await assert.rejects(
    run(m, "notes_append_to_note", f.ctx, {
      ...input,
      request_id: randomUUID(),
    }),
    { code: "STALE_REVISION" },
  );
  const latest = await run(m, "notes_read_note", f.ctx, { id });
  native.row.has_table = true;
  await assert.rejects(
    run(m, "notes_append_to_note", f.ctx, {
      ...input,
      content_hash: latest.content_hash,
      request_id: randomUUID(),
    }),
    { code: "FORMAT_UNSUPPORTED" },
  );
  f.ctx.grants = { notes_folders: [] };
  await assert.rejects(run(m, "notes_append_to_note", f.ctx, input), {
    code: "PERMISSION_DENIED",
  });
  f.state.close();
});
test("Reminders unknown native creates never retry, and revoked grants block receipts", async () => {
  const f = await fixture();
  f.ctx.grants = { reminder_lists: ["l1"] };
  let writes = 0;
  const native: NativeBridge = {
    async call<T>(_ctx, _helper, op, a) {
      if (op === "preflight") return { ready: true } as T;
      if (op === "reminder_create") {
        writes++;
        return {
          id: "r1",
          list_id: "l1",
          source_id: "s1",
          revision: "v1",
        } as T;
      }
      if (op === "reminder_get")
        return {
          id: "r1",
          list_id: "l1",
          source_id: "s1",
          revision: "v1",
        } as T;
      throw new Error(op);
    },
  };
  const m = new RemindersModule(f.cfg, native, f.refs, f.state),
    input = {
      title: "Test",
      list_id: f.refs.encode("reminder-list", { id: "l1" }),
      request_id: randomUUID(),
    };
  await assert.rejects(
    run(m, "reminders_create_reminder", f.ctx, {
      ...input,
      due: "2026-11-20",
      alerts_before: [30],
      request_id: randomUUID(),
    }),
    { code: "INVALID_INPUT" },
  );
  assert.equal(writes, 0);
  const r = await run(m, "reminders_create_reminder", f.ctx, input);
  assert.equal(r.verified, true);
  assert.equal(f.refs.decode<any>("reminder", r.resource.id).list, "l1");
  assert.equal(
    (await run(m, "reminders_create_reminder", f.ctx, input)).replayed,
    true,
  );
  assert.equal(writes, 1);
  f.ctx.grants = { reminder_lists: [] };
  await assert.rejects(run(m, "reminders_create_reminder", f.ctx, input), {
    code: "PERMISSION_DENIED",
  });
  f.state.close();
});
test("Messages uses read-only owned fixtures, exact handles, bounded history and approved iMessage only", async () => {
  const f = await fixture(),
    path = join(f.dir, "messages.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE chat(guid TEXT,display_name TEXT,service_name TEXT);CREATE TABLE message(guid TEXT,text TEXT,date INTEGER,is_from_me INTEGER,service TEXT,attributedBody BLOB);CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);CREATE TABLE handle(id TEXT);CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER);",
  );
  db.prepare("INSERT INTO chat VALUES(?,?,?)").run(
    "im-chat",
    "Test",
    "iMessage",
  );
  db.prepare("INSERT INTO chat VALUES(?,?,?)").run("sms-chat", "SMS", "SMS");
  db.prepare("INSERT INTO handle VALUES(?)").run("+819012345678");
  db.prepare("INSERT INTO chat_handle_join VALUES(?,?)").run(1, 1);
  db.prepare("INSERT INTO chat_handle_join VALUES(?,?)").run(2, 1);
  db.prepare("INSERT INTO message VALUES(?,?,?,?,?,?)").run(
    "m1",
    "hello",
    (Date.parse("2026-11-14T01:00:00Z") - Date.UTC(2001, 0, 1)) * 1e6,
    0,
    "iMessage",
    null,
  );
  db.prepare("INSERT INTO chat_message_join VALUES(?,?)").run(1, 1);
  db.close();
  f.ctx.grants = {
    message_chats: ["im-chat", "sms-chat"],
    message_recipients: ["+819012345678"],
  };
  const key = randomBytes(32),
    approval = new ApprovalStore(f.state, f.cfg, async () => key);
  let sends = 0;
  const native: NativeBridge = {
    async call<T>() {
      sends++;
      return { status: "send_submitted" } as T;
    },
  };
  const m = new MessagesModule(f.cfg, native, f.refs, approval, path),
    chat = f.refs.encode("message-chat", { guid: "im-chat" });
  const read = await run(m, "imessage_read_chat", f.ctx, {
    chat_id: chat,
    since: "2026-11-14T00:00:00Z",
    before: "2026-11-15T00:00:00Z",
  });
  assert.equal(read.messages[0].text, "hello");
  const action = await run(m, "imessage_send_message", f.ctx, {
    chat_id: chat,
    text: "test",
    request_id: randomUUID(),
  });
  await assert.rejects(
    run(m, "imessage_execute_send", f.ctx, { action_id: action.action_id }),
    { code: "APPROVAL_REQUIRED" },
  );
  await approval.review(f.ctx, action.action_id, async () => true);
  assert.equal(
    (
      await run(m, "imessage_execute_send", f.ctx, {
        action_id: action.action_id,
      })
    ).receipt.status,
    "send_submitted",
  );
  assert.equal(approval.status(f.ctx, action.action_id).sent, false);
  await run(m, "imessage_execute_send", f.ctx, { action_id: action.action_id });
  assert.equal(sends, 1);
  f.ctx.grants = { message_chats: [], message_recipients: [] };
  await assert.rejects(
    run(m, "imessage_execute_send", f.ctx, { action_id: action.action_id }),
    { code: "PERMISSION_DENIED" },
  );
  assert.throws(() => normalizeHandle("9012345678"), { code: "INVALID_INPUT" });
  assert.equal(decodeAttributedBody(Buffer.from("unknown")), undefined);
  const blob = Buffer.concat([
    Buffer.from("NSString+"),
    Buffer.from([6]),
    Buffer.from("测试"),
  ]);
  assert.equal(decodeAttributedBody(blob), "测试");
  f.state.close();
});
test("public-network guard rejects private, metadata, mapped and reserved destinations", () => {
  for (const a of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "2001:db8::1",
  ])
    assert.equal(isPublicAddress(a), false, a);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});
test("compiled EventKit value conversion preserves date-only and validates complex repeats without accessing user reminders", async () => {
  const f = await fixture(),
    native = new ProcessNativeBridge();
  const date = await native.call<any>(f.ctx, "reminders", "validate", {
    due: "2026-11-20",
    repeat: "FREQ=MONTHLY;BYDAY=1MO,-1FR;BYMONTH=1,6;COUNT=8",
    alerts_before: "30,5",
  });
  assert.equal(date.due, "2026-11-20");
  assert.equal(date.date_only, true);
  assert.match(date.repeat, /BYDAY=1MO,-1FR/);
  assert.equal(date.alarms, 2);
  for (const repeat of [
    "FREQ=DAILY;COUNT=2;UNTIL=20261201",
    "FREQ=MONTHLY;BYMONTH=-2",
    "FREQ=DAILY;BYSETPOS=1",
    "FREQ=DAILY;FREQ=WEEKLY",
  ])
    await assert.rejects(
      native.call(f.ctx, "reminders", "validate", {
        due: "2026-11-20",
        repeat,
      }),
      { code: "INVALID_INPUT" },
    );
  const timed = await native.call<any>(f.ctx, "reminders", "validate", {
    due: "2026-11-20T15:00:00+09:00",
    alerts_at: "2026-11-20T15:00:00+09:00",
  });
  assert.equal(timed.date_only, false);
  assert.equal(Date.parse(timed.due), Date.parse("2026-11-20T15:00:00+09:00"));
  f.state.close();
});
test("fixed OSAKit bridge treats script/SQL-like input as data and rejects unknown operations before app access", async () => {
  const f = await fixture();
  await assert.rejects(
    new ProcessNativeBridge().call(f.ctx, "automation", "not_an_operation", {
      id: "'; DROP TABLE notes; //",
      text: "$(touch /tmp/unwanted)",
    }),
    { code: "INVALID_INPUT" },
  );
  f.state.close();
});
test("Drive bounded text extraction, raw reads and frozen directory previews keep placeholders and changed children explicit", async () => {
  const f = await fixture(),
    root = join(f.dir, "files");
  await mkdir(root);
  f.ctx.grants = { drive_roots: [root] };
  const m = new DriveModule(
      f.cfg,
      new ProcessNativeBridge(),
      f.refs,
      f.state,
      f.dir,
    ),
    root_id = f.refs.encode("drive-root", { path: root });
  await writeFile(join(root, "a.rtf"), "{\\rtf1\\ansi Hello Apple2Agent}");
  const rtf = await run(m, "drive_read_file", f.ctx, {
    root_id,
    path: "a.rtf",
  });
  assert.match(rtf.text, /Hello Apple2Agent/);
  await writeFile(
    join(root, "page.html"),
    "<h1>Title</h1><script>do not execute</script><p>find this needle</p>",
  );
  const html = await run(m, "drive_read_file", f.ctx, {
    root_id,
    path: "page.html",
  });
  assert.match(html.text, /needle/);
  assert.doesNotMatch(html.text, /do not execute/);
  const raw = await run(m, "drive_get_file", f.ctx, {
    root_id,
    path: "page.html",
  });
  assert.ok(Buffer.from(raw.base64, "base64").includes(Buffer.from("needle")));
  const search = await run(m, "drive_search_content", f.ctx, {
    root_id,
    query: "needle",
  });
  assert.equal(search.matches[0].path, "page.html");
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "folder", "child.txt"), "before");
  const meta = await run(m, "drive_get_info", f.ctx, {
    root_id,
    path: "folder",
  });
  const input = {
    root_id,
    path: "folder",
    expected_revision: meta.revision,
    request_id: randomUUID(),
  };
  const preview = await run(m, "drive_trash_item", f.ctx, input);
  assert.equal(preview.preview.affected_items, 2);
  await writeFile(join(root, "folder", "child.txt"), "changed");
  await assert.rejects(
    run(m, "drive_trash_item", f.ctx, {
      ...input,
      preview_token: preview.preview_token,
    }),
    { code: "STALE_REVISION" },
  );
  assert.equal(
    await readFile(join(root, "folder", "child.txt"), "utf8"),
    "changed",
  );
  await writeFile(join(root, ".remote.txt.icloud"), "placeholder metadata");
  const cloud = await run(m, "drive_read_file", f.ctx, {
    root_id,
    path: "remote.txt",
  });
  assert.equal(cloud.sync_state, "cloud_only");
  assert.equal(cloud.text, undefined);
  const download = await run(m, "drive_read_file", f.ctx, {
    root_id,
    path: "remote.txt",
    download: true,
  });
  assert.equal(download.complete, false);
  assert.equal(download.download_state, "unavailable");
  f.state.close();
});
test("expired and rejected approvals clear private payloads while retaining replay tombstones", async () => {
  const f = await fixture(),
    key = randomBytes(32),
    approval = new ApprovalStore(f.state, f.cfg, async () => key);
  const id = randomUUID();
  await assert.rejects(
    approval.request(
      f.ctx,
      "mail_send",
      id,
      "mail:send",
      { text: "expires" },
      -1,
    ),
    { code: "APPROVAL_EXPIRED" },
  );
  const expired = f.state.entries<any>("approval:")[0]!.value;
  assert.equal(expired.ciphertext, "");
  assert.ok(expired.digest);
  const action = await approval.request(
    f.ctx,
    "mail_send",
    randomUUID(),
    "mail:send",
    { text: "discard" },
  );
  approval.discard(f.ctx, action.action_id);
  assert.equal(f.state.get<any>(`approval:${action.action_id}`).ciphertext, "");
  assert.equal(approval.status(f.ctx, action.action_id).status, "rejected");
  await assert.rejects(
    approval.execute(f.ctx, action.action_id, "mail_send", async () => {
      throw new Error("must not run");
    }),
    { code: "OUTCOME_UNKNOWN" },
  );
  f.state.close();
});
test("maintenance clears only expired private content and keeps durable write deduplication", async () => {
  const f = await fixture();
  const { maintenance } = await import("../src/core/maintenance.js");
  const { utimes } = await import("node:fs/promises");
  const path = join(f.dir, "backups", "notes");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const expired = join(path, "a".repeat(64) + ".json"),
    keep = join(path, "b".repeat(64) + ".json");
  await writeFile(expired, "old private backup");
  await writeFile(keep, "new private backup");
  await writeFile(join(path, "unrelated.txt"), "keep");
  const old = new Date(Date.now() - 31 * 86400000);
  await utimes(expired, old, old);
  f.state.put("mail-changes:test", { expires: Date.now() - 1, states: [] });
  f.state.put("mail-bulk:test", {
    created: old.valueOf(),
    account_id: "account",
    digest: "digest",
    rows: [{ private: "metadata" }],
  });
  let writes = 0;
  const ctx = f.ctx,
    id = randomUUID(),
    task = {
      prepare: async () => {},
      write: async () => {
        writes++;
        return { id: "retained" };
      },
      verify: async () => ({ id: "retained" }),
    };
  await f.state.write(ctx, "test", id, {}, task);
  const result = await maintenance(f.dir, f.state, f.approvals);
  assert.equal(result.removed_backups, 1);
  await assert.rejects(readFile(expired), { code: "ENOENT" });
  assert.equal(await readFile(keep, "utf8"), "new private backup");
  assert.equal(await readFile(join(path, "unrelated.txt"), "utf8"), "keep");
  assert.equal(f.state.get<any>("mail-bulk:test").expired, true);
  assert.equal(f.state.get<any>("mail-bulk:test").rows, undefined);
  assert.equal((await f.state.write(ctx, "test", id, {}, task)).replayed, true);
  assert.equal(writes, 1);
  f.state.close();
});
test("Reminders and Notes publish usable signed creation sources before any destination exists", async () => {
  const f = await fixture();
  f.ctx.grants = {
    reminder_sources: ["source"],
    reminder_lists: [],
    notes_accounts: ["account"],
    notes_folders: [],
  };
  let listCreated = false,
    folderCreated = false;
  const native: NativeBridge = {
    async call<T>(_ctx, _helper, op, a) {
      if (op === "reminder_lists")
        return { lists: [], sources: [{ id: "source", name: "iCloud" }] } as T;
      if (op === "preflight") return { ready: true } as T;
      if (op === "reminder_list_create") {
        assert.equal(a.source_id, "source");
        listCreated = true;
        return {
          id: "list-new",
          source_id: "source",
          revision: "list-rev",
        } as T;
      }
      if (op === "list_get")
        return { id: "list-new", revision: "list-rev" } as T;
      if (op === "notes_folders")
        return {
          folders: folderCreated ? [{ id: "folder-new", name: "Created" }] : [],
          accounts: [{ id: "account", name: "iCloud" }],
          complete: true,
        } as T;
      if (op === "notes_folder_create") {
        assert.equal(a.account_id, "account");
        folderCreated = true;
        return { id: "folder-new" } as T;
      }
      throw new Error(op);
    },
  };
  const reminders = new RemindersModule(f.cfg, native, f.refs, f.state),
    notes = new NotesModule(f.cfg, native, f.refs, f.state, f.dir);
  const lists = await run(reminders, "reminders_list_lists", f.ctx, {});
  const list = await run(reminders, "reminders_create_list", f.ctx, {
    source_id: lists.sources[0].id,
    name: "Created",
    request_id: randomUUID(),
  });
  assert.equal(listCreated, true);
  assert.equal(list.verified, true);
  assert.equal(
    f.refs.decode<any>("reminder-source", list.resource.source_id).id,
    "source",
  );
  const folders = await run(notes, "notes_list_folders", f.ctx, {});
  const folder = await run(notes, "notes_create_folder", f.ctx, {
    account_id: folders.accounts[0].id,
    name: "Created",
    request_id: randomUUID(),
  });
  assert.equal(folderCreated, true);
  assert.equal(folder.verified, true);
  assert.equal(
    f.refs.decode<any>("notes-folder", folder.resource.id).id,
    "folder-new",
  );
  f.state.close();
});

test("contact birthdays keep yearless age unknown, handle leap day explicitly, and reject malformed or future birth occurrences", async () => {
  const f = await fixture(),
    provider = new Cards();
  f.ctx.grants = { addressbooks: [provider.book] };
  const m = new ContactsModule(f.cfg, provider, f.refs, f.state),
    book = f.refs.encode("addressbook", provider.book);
  const cards = [
    ["yearless", "--0229"],
    ["known", "2000-02-29"],
    ["invalid", "2020-02-30"],
    ["future", "2030-02-28"],
  ];
  for (const [uid, bday] of cards) {
    const url = provider.book + uid + ".vcf";
    provider.data.set(url, {
      url,
      etag: '"1"',
      data: serializeCard([
        line("BEGIN", "VCARD"),
        line("VERSION", "3.0"),
        line("UID", uid!),
        line("FN", uid!),
        line("BDAY", bday!),
        line("END", "VCARD"),
      ]),
    });
  }
  const result = await run(m, "contacts_list_birthdays", f.ctx, {
    addressbook_id: book,
    from: "2027-02-27",
    days: 4,
  });
  assert.deepEqual(result.birthdays.map((r: any) => r.name).sort(), [
    "known",
    "yearless",
  ]);
  assert.equal(
    result.birthdays.find((r: any) => r.name === "yearless").age,
    undefined,
  );
  assert.equal(result.birthdays.find((r: any) => r.name === "known").age, 27);
  assert.ok(
    result.birthdays.every((r: any) => r.next_birthday === "2027-02-28"),
  );
  assert.equal(result.complete, false);
  assert.ok(result.warnings.length);
  const leap = await run(m, "contacts_list_birthdays", f.ctx, {
    addressbook_id: book,
    from: "2028-02-28",
    days: 3,
  });
  assert.ok(
    leap.birthdays
      .filter((r: any) => r.name === "known" || r.name === "yearless")
      .every((r: any) => r.next_birthday === "2028-02-29"),
  );
  f.state.close();
});
test("contact search pages keep missing emails explicit and expose incomplete pagination", async () => {
  const f = await fixture(),
    provider = new Cards();
  f.ctx.grants = { addressbooks: [provider.book] };
  const m = new ContactsModule(f.cfg, provider, f.refs, f.state),
    book = f.refs.encode("addressbook", provider.book);
  for (const [uid, name] of [
    ["1", "Émilie Gómez"],
    ["2", "Émilie Gómez Junior"],
  ]) {
    const url = provider.book + uid + ".vcf";
    provider.data.set(url, {
      url,
      etag: '"1"',
      data: serializeCard([
        line("BEGIN", "VCARD"),
        line("VERSION", "3.0"),
        line("UID", uid!),
        line("FN", name!),
        line("END", "VCARD"),
      ]),
    });
  }
  const first = await run(m, "contacts_search_contacts", f.ctx, {
    addressbook_id: book,
    query: "Emilie",
    limit: 1,
  });
  assert.equal(first.items.length, 1);
  assert.deepEqual(first.items[0].emails, []);
  assert.equal(first.complete, false);
  assert.ok(first.next_cursor);
  const next = await run(m, "contacts_search_contacts", f.ctx, {
    addressbook_id: book,
    query: "Emilie",
    limit: 1,
    cursor: first.next_cursor,
  });
  assert.equal(next.items.length, 1);
  assert.notEqual(first.items[0].id, next.items[0].id);
  assert.equal(next.complete, true);
  f.state.close();
});
