import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { schemas, validateCreate, interval } from "../src/core/schemas.js";
import { References } from "../src/core/references.js";
import { SQLiteOperationStore } from "../src/core/operations.js";
import { CalendarService } from "../src/services/calendar.js";
import { readEvents, makeEvent } from "../src/core/ical.js";
import { guardedFetch } from "../src/adapters/caldav.js";
import { parseMessage, IMAPAdapter } from "../src/adapters/imap.js";
import { fixture, eventInput } from "./fixtures.js";

test("reject ambiguous times, bad ranges, unknown fields, fractional limits and header injection", () => {
  assert.throws(() =>
    schemas.calendar_create.parse({
      ...eventInput(),
      start: "2026-11-14T10:00:00",
    }),
  );
  assert.throws(() =>
    validateCreate({ ...eventInput(), timezone: "America/New_York" }),
  );
  assert.throws(() =>
    validateCreate({ ...eventInput(), end: "2026-11-14T09:00:00+09:00" }),
  );
  assert.throws(() =>
    schemas.calendar_create.parse({
      ...eventInput(),
      attendees: ["other@example.com"],
    }),
  );
  assert.throws(() => schemas.mail_search.parse({ limit: 1.5 }));
  assert.throws(() => schemas.mail_search.parse({ since_date: "2026-02-30" }));
  assert.throws(() =>
    schemas.mail_draft_create.parse({
      subject: "ok\r\nBcc: secret@example.com",
      body_text: "x",
      request_id: randomUUID(),
    }),
  );
  assert.throws(() => interval("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"));
});
test("signed references reject tampering, wrong kinds and cross-account use; pagination rejects changed query", () => {
  const f = fixture();
  const token = f.refs.encode("message", { uid: 1 });
  assert.deepEqual(f.refs.decode("message", token), { uid: 1 });
  assert.throws(() => f.refs.decode("folder", token));
  assert.throws(() => f.refs.decode("message", token + "a"));
  assert.throws(() =>
    new References(
      { ...f.cfg, account_id: randomUUID() },
      f.cfg.ref_key,
    ).decode("message", token),
  );
  const page = f.refs.page([1, 2, 3], { q: "a" }, 1);
  assert.ok(page.next_cursor);
  assert.throws(() => f.refs.page([1, 2, 3], { q: "b" }, 1, page.next_cursor!));
  f.operations.close();
});
test("calendar writes read back, replay without duplicate, and conflict on changed payload", async () => {
  const f = fixture();
  const input = eventInput();
  const first = await f.calendar.create(f.ctx, input);
  assert.equal(first.verified, true);
  assert.equal((await f.calendar.create(f.ctx, input)).replayed, true);
  assert.equal(f.cal.writes, 1);
  await assert.rejects(
    f.calendar.create(f.ctx, { ...input, title: "different" }),
    { code: "REQUEST_CONFLICT" },
  );
  f.operations.close();
});
test("lost Calendar PUT receipt recovers by stable UID without resubmission", async () => {
  const f = fixture();
  const input = eventInput();
  f.cal.loseReply = true;
  await assert.rejects(f.calendar.create(f.ctx, input), {
    code: "OUTCOME_UNKNOWN",
  });
  assert.equal((await f.calendar.create(f.ctx, input)).verified, true);
  assert.equal(f.cal.writes, 1);
  f.operations.close();
});
test("accepted write with failed verification remains accepted and never resubmits", async () => {
  const f = fixture();
  const input = eventInput();
  f.cal.readFails = 1;
  assert.equal(
    (await f.calendar.create(f.ctx, input)).status,
    "write_accepted_unverified",
  );
  assert.equal((await f.calendar.create(f.ctx, input)).verified, true);
  assert.equal(f.cal.writes, 1);
  f.operations.close();
});
test("two processes/stores and actors share the atomic write claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apple2agent-test-"));
  const path = join(dir, "operations.sqlite");
  const f = fixture(path);
  const second = new SQLiteOperationStore(path);
  const service = new CalendarService(f.cfg, f.cal, f.refs, second);
  f.cal.delay = 40;
  const input = eventInput();
  const results = await Promise.allSettled([
    f.calendar.create(f.ctx, input),
    service.create({ ...f.ctx, actor_id: "client-b" }, input),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.cal.writes, 1);
  f.operations.close();
  second.close();
  const restarted = new SQLiteOperationStore(path);
  const after = new CalendarService(f.cfg, f.cal, f.refs, restarted);
  assert.equal((await after.create(f.ctx, input)).verified, true);
  assert.equal(f.cal.writes, 1);
  restarted.close();
});
test("read-only or revoked callers cannot write or recover cached write results", async () => {
  const f = fixture();
  const input = eventInput();
  await f.calendar.create(f.ctx, input);
  const readonly = {
    ...f.ctx,
    capabilities: new Set(["calendar:read"] as const),
  };
  await assert.rejects(f.calendar.create(readonly, input), {
    code: "PERMISSION_DENIED",
  });
  await assert.rejects(
    f.calendar.create({ ...f.ctx, account_id: randomUUID() }, input),
    { code: "PERMISSION_DENIED" },
  );
  assert.equal((await f.calendar.list(readonly)).calendars.length, 2);
  f.operations.close();
});
test("cancelling one request leaves another caller usable", async () => {
  const f = fixture();
  const c = new AbortController();
  c.abort();
  await assert.rejects(f.calendar.list({ ...f.ctx, signal: c.signal }));
  assert.equal((await f.calendar.list(f.ctx)).calendars.length, 2);
  f.operations.close();
});
test("iCalendar escaping preserves one event and does not create injected attendees", () => {
  const input = {
    ...eventInput(),
    title: "中文\nATTENDEE:mailto:bad@example.com",
    notes: "x, y; z\\\nEND:VEVENT",
  };
  const raw = makeEvent(
    input,
    "uid",
    new Date(input.start),
    new Date(input.end),
  );
  const root = new ICAL.Component(ICAL.parse(raw));
  assert.equal(root.getAllSubcomponents("vevent").length, 1);
  assert.equal(
    root.getFirstSubcomponent("vevent")!.getFirstProperty("attendee"),
    null,
  );
  const parsed = readEvents(
    raw,
    new Date("2026-11-14T00:00:00Z"),
    new Date("2026-11-15T00:00:00Z"),
    "Asia/Tokyo",
  );
  assert.equal(parsed.events[0]?.title, input.title);
});
test("read overlapping, all-day, repeating and moved exception instances without duplicating them", () => {
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:series",
    "DTSTART:20261113T010000Z",
    "DTEND:20261113T020000Z",
    "RRULE:FREQ=DAILY;COUNT=3",
    "EXDATE:20261114T010000Z",
    "SUMMARY:Series",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:series",
    "RECURRENCE-ID:20261115T010000Z",
    "DTSTART:20261115T030000Z",
    "DTEND:20261115T040000Z",
    "SUMMARY:Moved",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:day",
    "DTSTART;VALUE=DATE:20261113",
    "DTEND;VALUE=DATE:20261114",
    "SUMMARY:All day",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const result = readEvents(
    raw,
    new Date("2026-11-13T01:30:00Z"),
    new Date("2026-11-16T00:00:00Z"),
    "Asia/Tokyo",
  );
  assert.equal(result.events.filter((e) => e.uid === "series").length, 2);
  assert.equal(result.events.filter((e) => e.title === "Moved").length, 1);
  assert.equal(result.events.find((e) => e.uid === "day")?.start, "2026-11-13");
  assert.equal(result.truncated, false);
});
test("email draft is a real MIME message, saved once, supports no recipients and lost replies", async () => {
  const f = fixture();
  const input = {
    subject: "确认测试",
    body_text: "第一行\n第二行",
    request_id: randomUUID(),
  };
  f.imap.loseReply = true;
  await assert.rejects(f.mail.draft(f.ctx, input), { code: "OUTCOME_UNKNOWN" });
  const result = await f.mail.draft(f.ctx, input);
  assert.equal(result.verified, true);
  assert.equal(result.sent, false);
  assert.equal(f.imap.appends, 1);
  assert.equal(f.imap.flagChanges, 0);
  f.operations.close();
});
test("draft recipients survive MIME encoding and verification", async () => {
  const f = fixture();
  const result = await f.mail.draft(f.ctx, {
    subject: "Subject",
    body_text: "Body",
    to: ["person@example.com"],
    cc: ["other@example.com"],
    request_id: randomUUID(),
  });
  assert.equal(result.verified, true);
  assert.equal(f.imap.appends, 1);
  f.operations.close();
});
test("message reading preserves unread and rejects changed mailbox identity", async () => {
  const f = fixture();
  await f.mail.draft(f.ctx, {
    subject: "A",
    body_text: "body",
    request_id: randomUUID(),
  });
  const message = [...f.imap.messages.values()][0]!;
  const token = f.refs.encode("message", message.ref);
  const read = await f.mail.read(f.ctx, { message_ref: token, max_chars: 2 });
  assert.equal(read.body_text, "bo");
  assert.equal(read.unread, true);
  assert.equal(read.truncated, true);
  f.imap.uv = "99";
  await assert.rejects(
    f.mail.read(f.ctx, { message_ref: token, max_chars: 100 }),
    { code: "STALE_REFERENCE" },
  );
  f.operations.close();
});
test("missing Drafts role never falls back to inbox", async () => {
  const f = fixture();
  f.imap.folders = async () => [
    { path: "INBOX", name: "Inbox", selectable: true },
  ];
  await assert.rejects(
    f.mail.draft(f.ctx, {
      subject: "x",
      body_text: "y",
      request_id: randomUUID(),
    }),
    { code: "DRAFTS_FOLDER_UNRESOLVED" },
  );
  assert.equal(f.imap.appends, 0);
  f.operations.close();
});
test("MIME decoding handles Chinese, HTML and bounds without fetching embedded resources", async () => {
  const raw = Buffer.from(
    'Subject: =?UTF-8?B?5rWL6K+V?=\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>你好</p><img src="https://example.invalid/pixel"><a href="https://example.invalid">link</a>',
  );
  const parsed = await parseMessage(raw, 3);
  assert.ok(parsed.body_text.startsWith("你好"));
  assert.equal(parsed.truncated, true);
});
test("DAV redirect guard never forwards credentials to a third-party endpoint", async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response("", {
      status: 302,
      headers: { location: "https://attacker.invalid/" },
    });
  }) as typeof fetch;
  await assert.rejects(
    guardedFetch(AbortSignal.timeout(1000), fake)(
      "https://caldav.icloud.com/",
      { headers: { Authorization: "Basic private" } },
    ),
    { code: "ENDPOINT_UNSUPPORTED" },
  );
  assert.equal(calls, 1);
});
test("DAV responses enforce a byte cap while reading, not after parsing", async () => {
  const fake = (async () =>
    new Response(new Uint8Array(12 * 1024 * 1024 + 1))) as typeof fetch;
  await assert.rejects(
    guardedFetch(AbortSignal.timeout(1000), fake)("https://caldav.icloud.com/"),
    { code: "CONTENT_TOO_LARGE" },
  );
});
test("services have no transport, keychain or process-global dependencies", async () => {
  for (const file of ["calendar", "mail"]) {
    const source = await readFile(
      new URL(`../src/services/${file}.ts`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /from ['"](?:@modelcontextprotocol|node:child_process|node:fs|node:process)|process\.(?:env|exit|stdout|stdin)|KeychainCredentialStore/,
    );
  }
});

test("unconfigured Mail does not access credentials or attempt a network connection", async () => {
  const f = fixture();
  f.cfg.imap_username = "";
  let credentialReads = 0;
  const adapter = new IMAPAdapter(
    f.cfg,
    {
      get: async () => {
        credentialReads++;
        throw new Error("must not be called");
      },
    },
    () => {
      throw new Error("must not connect");
    },
  );
  await assert.rejects(adapter.folders(f.ctx), { code: "NOT_CONFIGURED" });
  assert.equal(credentialReads, 0);
  f.operations.close();
});
