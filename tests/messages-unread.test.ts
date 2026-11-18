import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./fixtures.js";
import type { AccessContext } from "../src/core/context.js";
import { References } from "../src/core/references.js";
import { HubState } from "../src/core/hub-state.js";
import { ApprovalStore } from "../src/core/approvals.js";
import { MessagesModule } from "../src/modules/messages.js";

const epoch = Date.UTC(2001, 0, 1);
const seconds = (Date.parse("2026-11-18T00:00:00Z") - epoch) / 1000;
const nanos = BigInt(seconds) * 1000000000n;
async function fixture(t: TestContext, readState = true) {
  const dir = await mkdtemp(join(tmpdir(), "a2a-unread-sms-"));
  const path = join(dir, "messages.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE chat(guid TEXT,display_name TEXT,service_name TEXT);
    CREATE TABLE message(guid TEXT,text TEXT,date INTEGER,is_from_me INTEGER,service TEXT,
      ${readState ? "is_read INTEGER," : ""} date_read INTEGER,attributedBody BLOB,
      is_system_message INTEGER,is_spam INTEGER,date_retracted INTEGER,associated_message_type INTEGER);
    CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);
    CREATE TABLE handle(id TEXT);
    CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER);`);
  for (const [guid, service] of [
    ["sms-a", "SMS"],
    ["sms-b", "SMS"],
    ["private-chat", "SMS"],
    ["im-chat", "iMessage"],
  ]) {
    db.prepare("INSERT INTO chat VALUES(?,?,?)").run(guid, guid, service);
  }
  db.prepare("INSERT INTO handle VALUES(?)").run("12345");
  db.exec("INSERT INTO chat_handle_join VALUES(1,1)");
  const cfg = config();
  const state = new HubState(join(dir, "state.sqlite"));
  const refs = new References(cfg, cfg.ref_key);
  const approvals = new ApprovalStore(state, cfg, async () =>
    assert.fail("Read accessed approval key"),
  );
  const module = new MessagesModule(
    cfg,
    {
      async call() {
        assert.fail("Read invoked a native operation");
      },
    },
    refs,
    approvals,
    path,
  );
  const ctx: AccessContext = {
    owner_id: cfg.owner_id,
    account_id: cfg.account_id,
    actor_id: "offline-test",
    capabilities: new Set(["messages:read"]),
    grants: { message_chats: ["sms-a", "sms-b"] },
    signal: AbortSignal.timeout(30000),
  };
  const run = (args: unknown = {}) => {
    const tool = module.tools.imessage_list_unread_sms!;
    return tool.run(ctx, tool.schema.parse(args));
  };
  const add = (guid: string, overrides: Record<string, any> = {}, chat = 1) => {
    const row: Record<string, any> = {
      guid,
      text: guid,
      date: nanos,
      is_from_me: 0,
      service: "SMS",
      ...(readState ? { is_read: 0 } : {}),
      ...overrides,
    };
    const id = db
      .prepare(
        `INSERT INTO message(${Object.keys(row).join(",")}) VALUES(${Object.keys(
          row,
        )
          .map(() => "?")
          .join(",")})`,
      )
      .run(...Object.values(row)).lastInsertRowid;
    db.prepare("INSERT INTO chat_message_join VALUES(?,?)").run(chat, id);
    return id;
  };
  t.after(() => {
    db.close();
    state.close();
  });
  return { path, db, cfg, refs, module, ctx, run, add, state };
}

test("unread SMS uses explicit incoming state across only authorized chats and never writes", async (t) => {
  const f = await fixture(t);
  f.add("unread-a", { date_read: 123 }); // Receipt timestamp must not override local is_read.
  const b = f.add("unread-b", {}, 2);
  f.db.prepare("INSERT INTO chat_message_join VALUES(?,?)").run(1, b);
  f.db.prepare("INSERT INTO chat_message_join VALUES(?,?)").run(3, b);
  f.add("read", { is_read: 1, date_read: null });
  f.add("outgoing", { is_from_me: 1 });
  f.add("private", {}, 3);
  f.add("imessage", { service: "iMessage" }, 1);
  f.add("rcs", { service: "RCS" }, 1);
  f.add("spam", { is_spam: 1 });
  f.add("system", { is_system_message: 1 });
  f.add("retracted", { date_retracted: 1 });
  f.add("reaction", { associated_message_type: 2001 });
  const before = await readFile(f.path);
  const result = await f.run();
  assert.deepEqual(
    result.messages.map((m: any) => m.id),
    ["unread-b", "unread-a"],
  );
  assert.ok(
    result.messages.every(
      (m: any) => m.unread && !m.from_me && m.service === "SMS",
    ),
  );
  assert.deepEqual(
    result.messages[0].chat_ids.map(
      (id: string) => f.refs.decode<any>("message-chat", id).guid,
    ),
    ["sms-a", "sms-b"],
  );
  assert.equal(result.complete, true);
  assert.equal(result.next_cursor, null);
  assert.equal(result.read_state_source, "message.is_read");
  assert.deepEqual(await readFile(f.path), before);
  assert.deepEqual(f.state.entries("approval:"), []);
});

test("unread SMS pages tied timestamps and mixed timestamp units without duplicates", async (t) => {
  const f = await fixture(t);
  f.add("old", { date: seconds - 1 });
  f.add("same-seconds", { date: seconds });
  f.add("same-nanos", { date: nanos });
  f.add("new", { date: nanos + 1000000000n });
  const first = await f.run({ limit: 2 });
  assert.deepEqual(
    first.messages.map((m: any) => m.id),
    ["new", "same-nanos"],
  );
  assert.equal(first.messages[1].date, "2026-11-18T00:00:00.000Z");
  assert.equal(first.complete, false);
  assert.equal(first.has_more, true);
  const second = await f.run({ limit: 2, cursor: first.next_cursor });
  assert.deepEqual(
    second.messages.map((m: any) => m.id),
    ["same-seconds", "old"],
  );
  assert.equal(second.next_cursor, null);
  assert.equal(second.complete, true);
});

test("unread SMS pagination reflects read changes and requires restart for new arrivals", async (t) => {
  const f = await fixture(t);
  f.add("old", { date: nanos - 1000000000n });
  f.add("new");
  const first = await f.run({ limit: 1 });
  f.db.prepare("UPDATE message SET is_read=1 WHERE guid=?").run("old");
  f.add("arrival", { date: nanos + 1000000000n });
  assert.equal((await f.run({ cursor: first.next_cursor })).messages.length, 0);
  assert.equal((await f.run()).messages[0].id, "arrival");
});

test("unread SMS rejects missing capability, missing grants, changed scope and invalid cursors", async (t) => {
  const f = await fixture(t);
  f.add("one");
  f.add("two");
  const first = await f.run({ limit: 1 });
  f.ctx.capabilities = new Set();
  await assert.rejects(f.run(), { code: "PERMISSION_DENIED" });
  f.ctx.capabilities = new Set(["messages:read"]);
  f.ctx.grants = { message_chats: [] };
  await assert.rejects(f.run(), { code: "NOT_CONFIGURED" });
  f.ctx.grants = { message_chats: ["private-chat"] };
  await assert.rejects(f.run({ cursor: first.next_cursor }), {
    code: "STALE_REFERENCE",
  });
  f.ctx.grants = { message_chats: ["sms-a", "sms-b"] };
  await assert.rejects(f.run({ cursor: first.next_cursor + "tampered" }), {
    code: "STALE_REFERENCE",
  });
  const decoded = f.refs.decode<any>("unread-sms-cursor", first.next_cursor);
  await assert.rejects(
    f.run({
      cursor: f.refs.encode("unread-sms-cursor", { ...decoded, expires: 0 }),
    }),
    { code: "STALE_REFERENCE" },
  );
  const foreign = new References(
    { ...f.cfg, account_id: "other-fixture-account" },
    f.cfg.ref_key,
  );
  await assert.rejects(
    f.run({ cursor: foreign.encode("unread-sms-cursor", decoded) }),
    { code: "STALE_REFERENCE" },
  );
  assert.throws(() => f.run({ approved: true }));
  assert.throws(() => f.run({ limit: 101 }));
});

test("missing or unknown unread state never becomes an empty-inbox claim", async (t) => {
  const old = await fixture(t, false);
  old.add("old-layout", { date_read: 0 });
  await assert.rejects(old.run(), { code: "SCHEMA_UNSUPPORTED" });
  // Older layouts remain readable through the unchanged history interface.
  const tool = old.module.tools.imessage_read_chat!;
  const history = await tool.run(
    old.ctx,
    tool.schema.parse({
      chat_id: old.refs.encode("message-chat", { guid: "sms-a" }),
      since: "2026-11-17T00:00:00Z",
      before: "2026-11-19T00:00:00Z",
    }),
  );
  assert.equal(history.messages[0].text, "old-layout");
  const f = await fixture(t);
  f.add("unknown", { is_read: null });
  f.add("unsupported-state", { is_read: 2 });
  f.add("known");
  const result = await f.run();
  assert.deepEqual(
    result.messages.map((m: any) => m.id),
    ["known"],
  );
  assert.equal(result.unknown_read_states, true);
  assert.equal(result.complete, false);
});

test("unread SMS bounds text and flags unsupported bodies without hiding the message", async (t) => {
  const f = await fixture(t);
  f.add("missing-body", {
    text: null,
    attributedBody: Buffer.from("unknown encoding"),
  });
  f.add("long-body", { text: "a".repeat(9000) });
  f.add("attributed", {
    text: null,
    attributedBody: Buffer.concat([
      Buffer.from("NSString+"),
      Buffer.from([5]),
      Buffer.from("hello"),
    ]),
  });
  const r = await f.run();
  assert.equal(r.messages[0].text, "hello");
  assert.equal(r.messages[1].text.length, 8192);
  assert.equal(r.messages[1].truncated, true);
  assert.equal(r.messages[2].body_supported, false);
  assert.equal(r.messages[2].text, null);
  assert.equal(r.unsupported_bodies, 1);
  assert.equal(r.complete, false);
});

test("selecting a short-code chat enables reads without authorizing SMS or iMessage sends", async (t) => {
  const { messageSetupChoices } =
    await import("../src/core/message-choices.js");
  const f = await fixture(t);
  f.add("short-code-unread");
  const choices = messageSetupChoices(f.db);
  const selected = choices.find(
    (c) => c.kind === "message_chats" && c.id === "sms-a",
  )!;
  assert.ok(selected);
  assert.equal(
    choices.filter((c) => c.kind === "message_recipients").length,
    0,
  );
  // Model selecting only the read-chat checkbox in an isolated config.
  f.ctx.grants = { message_chats: [selected.id], message_recipients: [] };
  assert.equal((await f.run()).messages[0].text, "short-code-unread");
  const send = f.module.tools.imessage_send_message!;
  const smsArgs = send.schema.parse({
    chat_id: f.refs.encode("message-chat", { guid: selected.id }),
    text: "synthetic",
    request_id: "00000000-0000-4000-a000-000000000001",
  });
  await assert.rejects(send.run(f.ctx, smsArgs), { code: "PERMISSION_DENIED" });
  // Even a caller with the existing send capability cannot send to an SMS chat.
  f.ctx.capabilities.add("messages:send");
  await assert.rejects(send.run(f.ctx, smsArgs), {
    code: "SERVICE_UNSUPPORTED",
  });
  f.db.prepare("INSERT INTO handle VALUES(?)").run("sender@example.com");
  f.db.exec("INSERT INTO chat_handle_join VALUES(4,2)");
  f.ctx.grants.message_chats = ["im-chat"];
  await assert.rejects(
    send.run(f.ctx, {
      ...smsArgs,
      chat_id: f.refs.encode("message-chat", { guid: "im-chat" }),
    }),
    { code: "PERMISSION_DENIED" },
  );
  assert.deepEqual(f.state.entries("approval:"), []);
});

test("automatic SMS scope admits a new number on the next query and limits mixed history to SMS", async (t) => {
  const f = await fixture(t);
  f.ctx.grants = {
    sms_read_scope: "all_sms",
    message_chats: [],
    message_recipients: [],
  };
  const call = (name: string, args: unknown) => {
    const tool = f.module.tools[name]!;
    return tool.run(f.ctx, tool.schema.parse(args));
  };
  assert.equal((await f.run()).messages.length, 0);
  const rowid = Number(
    f.db
      .prepare("INSERT INTO chat VALUES(?,?,?)")
      .run("new-number", "Fixture", "SMS").lastInsertRowid,
  );
  f.add("first-incoming-sms", {}, rowid);
  assert.deepEqual(
    (await f.run()).messages.map((m: any) => m.id),
    ["first-incoming-sms"],
  );
  f.add("secret-imessage", { service: "iMessage" }, 4);
  const chat_id = f.refs.encode("message-chat", { guid: "im-chat" });
  const args = {
    chat_id,
    since: "2026-11-17T00:00:00Z",
    before: "2026-11-19T00:00:00Z",
  };
  await assert.rejects(call("imessage_read_chat", args), {
    code: "PERMISSION_DENIED",
  });
  f.add("mixed-sms", {}, 4);
  f.add("private-rcs", { service: "RCS" }, 4);
  const page = await f.run({ limit: 1 });
  assert.equal(page.scope.sms_read_scope, "all_sms");
  const listed = await call("imessage_list_chats", {});
  assert.ok(listed.chats.some((c: any) => c.chat_id === chat_id));
  assert.deepEqual(
    (await call("imessage_read_chat", args)).messages.map((m: any) => m.id),
    ["mixed-sms"],
  );
  assert.equal(
    (await call("imessage_search_messages", { ...args, query: "secret" }))
      .messages.length,
    0,
  );
  // Even a caller with send capability and an approved recipient needs an explicit chat grant.
  f.ctx.capabilities = new Set(["messages:read", "messages:send"]);
  f.ctx.grants.message_recipients = ["sender@example.com"];
  f.db.exec(
    "INSERT INTO handle VALUES('sender@example.com'); INSERT INTO chat_handle_join VALUES(4,2)",
  );
  await assert.rejects(
    call("imessage_send_message", {
      chat_id,
      text: "test",
      request_id: "00000000-0000-4000-a000-000000000001",
    }),
    { code: "PERMISSION_DENIED" },
  );
  assert.deepEqual(f.state.entries("approval:"), []);
  f.ctx.grants = { sms_read_scope: "selected", message_chats: ["sms-a"] };
  assert.equal((await f.run()).messages.length, 0);
  await assert.rejects(f.run({ cursor: page.next_cursor }), {
    code: "STALE_REFERENCE",
  });
  await assert.rejects(call("imessage_read_chat", args), {
    code: "PERMISSION_DENIED",
  });
  f.ctx.grants = { sms_read_scope: "all_sms", message_chats: ["im-chat"] };
  assert.equal((await call("imessage_read_chat", args)).messages.length, 3);
});
