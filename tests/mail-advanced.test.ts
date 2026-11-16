import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { simpleParser } from "mailparser";
import { MailModule } from "../src/modules/mail.js";
import { AppError } from "../src/core/errors.js";
import { config } from "./fixtures.js";
import { References, hash } from "../src/core/references.js";
import { HubState } from "../src/core/hub-state.js";
import { ApprovalStore } from "../src/core/approvals.js";
import { allCapabilities, type AccessContext } from "../src/core/context.js";
class MemoryIMAP {
  rows = new Map<string, { source: Buffer; flags: string[]; ref: any }>();
  next = 1;
  appends = 0;
  lose = false;
  sentCopyFail = false;
  async folders() {
    return [
      { path: "INBOX", selectable: true },
      { path: "Drafts", special_use: "\\Drafts", selectable: true },
      { path: "Sent", special_use: "\\Sent", selectable: true },
      { path: "Trash", special_use: "\\Trash", selectable: true },
    ];
  }
  key(r: any) {
    return r.folder + ":" + r.uid;
  }
  async appendRaw(_ctx: any, folder: string, source: Buffer, flags: string[]) {
    if (folder === "Sent" && this.sentCopyFail) throw new Error("copy failed");
    this.appends++;
    const ref = { folder, uidvalidity: "1", uid: this.next++ };
    this.rows.set(this.key(ref), { source, flags, ref });
    if (this.lose) {
      this.lose = false;
      throw new Error("lost append");
    }
    return ref;
  }
  async raw(_ctx: any, ref: any) {
    const r = this.rows.get(this.key(ref));
    if (!r || ref.uidvalidity !== "1") throw new AppError("NOT_FOUND", "gone");
    return {
      ...r,
      revision: hash([r.source.toString("base64"), r.flags.slice().sort()]),
    };
  }
  async find(ctx: any, folder: string, messageId: string) {
    for (const r of this.rows.values()) {
      if (
        r.ref.folder === folder &&
        (await simpleParser(r.source)).messageId === messageId
      )
        return { ref: r.ref };
    }
    return undefined;
  }
  async mark(ctx: any, ref: any, c: any, expected: string) {
    const r = await this.raw(ctx, ref);
    if (expected !== r.revision)
      throw new AppError("STALE_REVISION", "changed");
    for (const [k, f] of [
      ["seen", "\\Seen"],
      ["flagged", "\\Flagged"],
      ["answered", "\\Answered"],
    ]) {
      if (c[k!] !== undefined) {
        const flags = this.rows.get(this.key(ref))!.flags;
        if (c[k!] && !flags.includes(f!)) flags.push(f!);
        if (!c[k!])
          this.rows.get(this.key(ref))!.flags = flags.filter((x) => x !== f);
      }
    }
    return { ref };
  }
  async move(ctx: any, ref: any, target: string, expected: string) {
    const r = await this.raw(ctx, ref);
    if (r.revision !== expected)
      throw new AppError("STALE_REVISION", "changed");
    const dest = await this.appendRaw(ctx, target, r.source, r.flags);
    this.rows.delete(this.key(ref));
    return dest;
  }
  async read(ctx: any, ref: any) {
    const r = await this.raw(ctx, ref),
      p = await simpleParser(r.source);
    return {
      ref,
      subject: p.subject ?? "",
      body_text: p.text ?? "",
      from: p.from?.value ?? [],
      to: Array.isArray(p.to)
        ? p.to.flatMap((x) => x.value)
        : (p.to?.value ?? []),
      unread: !r.flags.includes("\\Seen"),
      draft: r.flags.includes("\\Draft"),
    };
  }
  async search(_ctx: any, folder: string) {
    return {
      uidvalidity: "1",
      uids: [...this.rows.values()]
        .filter((r) => r.ref.folder === folder)
        .map((r) => r.ref.uid)
        .sort((a, b) => b - a),
    };
  }
  async changes(ctx: any, folder: string, uv: string, uids: number[]) {
    return Promise.all(
      uids.map(async (uid) => ({
        uid,
        fingerprint: (await this.raw(ctx, { folder, uidvalidity: uv, uid }))
          .revision,
      })),
    );
  }
  async summaries(ctx: any, folder: string, uv: string, uids: number[]) {
    return Promise.all(
      uids.map((uid) => this.read(ctx, { folder, uidvalidity: uv, uid })),
    );
  }
}
async function setup() {
  const cfg = config(),
    dir = await mkdtemp(join(tmpdir(), "a2a-mail-")),
    state = new HubState(join(dir, "ops.sqlite")),
    refs = new References(cfg, cfg.ref_key),
    key = randomBytes(32),
    approvals = new ApprovalStore(state, cfg, async () => key),
    imap = new MemoryIMAP(),
    sent: any[] = [];
  const smtp = {
    async send(_ctx: any, raw: Buffer, recipients: string[]) {
      sent.push({ raw, recipients });
      return {
        status: "upstream_accepted",
        accepted_count: recipients.length,
        rejected_count: 0,
        delivered: false,
      };
    },
  };
  const ctx: AccessContext = {
    owner_id: cfg.owner_id,
    account_id: cfg.account_id,
    actor_id: "tests",
    capabilities: new Set(allCapabilities),
    grants: { mail_accounts: ["icloud:primary"] },
    signal: AbortSignal.timeout(30000),
  };
  const m = new MailModule(
    cfg,
    imap as any,
    smtp as any,
    {
      call: async () => {
        throw new Error("unexpected native call");
      },
    },
    refs,
    state,
    approvals,
  );
  const account_id = refs.encode("mail-account", {
    backend: "icloud",
    id: "primary",
  });
  return { cfg, dir, state, refs, approvals, imap, sent, ctx, m, account_id };
}
async function run(f: any, name: string, args: any) {
  const t = f.m.tools[name];
  return t.run(f.ctx, t.schema.parse(args));
}
test("rich draft verifies complete MIME and lost APPEND recovers without a second copy", async () => {
  const f = await setup();
  const input = {
    account_id: f.account_id,
    to: ["a@example.com"],
    bcc: ["hidden@example.com"],
    subject: "草稿",
    text: "正文",
    html: "<p>正文</p>",
    attachments: [
      {
        filename: "测试.txt",
        content_type: "text/plain",
        base64: Buffer.from("附件").toString("base64"),
      },
    ],
    request_id: randomUUID(),
  };
  f.imap.lose = true;
  await assert.rejects(run(f, "mail_save_draft", input), {
    code: "OUTCOME_UNKNOWN",
  });
  const r = await run(f, "mail_save_draft", input);
  assert.equal(r.verified, true);
  assert.equal(f.imap.appends, 1);
  assert.equal(r.draft_state, "draft_saved_server_verified");
  const read = await run(f, "mail_get_message", {
    account_id: f.account_id,
    message_ref: r.resource.message_ref,
  });
  assert.equal(read.unread, true);
  const attachment = await run(f, "mail_get_attachment", {
    account_id: f.account_id,
    message_ref: r.resource.message_ref,
    index: 0,
  });
  assert.equal(Buffer.from(attachment.base64, "base64").toString(), "附件");
  const edit = {
    ...input,
    message_ref: r.resource.message_ref,
    expected_revision: read.revision,
    text: "更新",
    request_id: randomUUID(),
  };
  const updated = await run(f, "mail_update_draft", edit);
  assert.equal(updated.verified, true);
  assert.equal((await run(f, "mail_update_draft", edit)).replayed, true);
  assert.equal(f.sent.length, 0);
  f.state.close();
});
test("mail sends freeze exact content, hide Bcc, require native approval and never resend to repair Sent", async () => {
  const f = await setup();
  const a = await run(f, "mail_send_message", {
    account_id: f.account_id,
    to: ["a@example.com"],
    bcc: ["hidden@example.com"],
    subject: "Send",
    text: "hello",
    request_id: randomUUID(),
  });
  assert.equal(a.status, "queued_for_approval");
  await assert.rejects(
    run(f, "mail_execute_send", { action_id: a.action_id }),
    { code: "APPROVAL_REQUIRED" },
  );
  await f.approvals.review(f.ctx, a.action_id, async (op, payload) => {
    assert.equal(op, "mail_send");
    assert.deepEqual((payload as any).summary.bcc, ["hidden@example.com"]);
    return true;
  });
  f.imap.sentCopyFail = true;
  const result = await run(f, "mail_execute_send", { action_id: a.action_id });
  assert.equal(result.receipt.status, "upstream_accepted");
  assert.equal(result.receipt.sent_copy.status, "unverified");
  assert.equal(result.receipt.delivered, false);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].recipients, [
    "a@example.com",
    "hidden@example.com",
  ]);
  assert.equal((await simpleParser(f.sent[0].raw)).bcc, undefined);
  await run(f, "mail_execute_send", { action_id: a.action_id });
  assert.equal(f.sent.length, 1);
  f.ctx.grants = { mail_accounts: [] };
  await assert.rejects(
    run(f, "mail_execute_send", { action_id: a.action_id }),
    { code: "PERMISSION_DENIED" },
  );
  f.state.close();
});
test("bulk freezes matches, stale versions skip, and undo restores only verified identities", async () => {
  const f = await setup();
  for (const n of ["one", "two"])
    await run(f, "mail_save_draft", {
      account_id: f.account_id,
      subject: n,
      text: n,
      request_id: randomUUID(),
    });
  const folder = f.refs.encode("hub-folder", {
    backend: "icloud",
    account: "primary",
    path: "Drafts",
  });
  const input = {
    account_id: f.account_id,
    folder_ids: [folder],
    action: "star",
    request_id: randomUUID(),
  };
  const preview = await run(f, "mail_run_bulk_action", input);
  assert.equal(preview.preview.length, 2);
  const first = f.refs.decode<any>(
    "hub-message",
    preview.preview[0].message_ref,
  );
  f.imap.rows.get(f.imap.key(first.ref))!.flags.push("\\Seen");
  await run(f, "mail_save_draft", {
    account_id: f.account_id,
    subject: "later",
    text: "later",
    request_id: randomUUID(),
  });
  const result = await run(f, "mail_run_bulk_action", {
    ...input,
    preview_token: preview.preview_token,
  });
  assert.equal(result.results.length, 2);
  assert.equal(result.status, "partial");
  const later = [...f.imap.rows.values()].find((r) =>
    r.source.includes(Buffer.from("later")),
  )!;
  assert.equal(later.flags.includes("\\Flagged"), false);
  const undo = await run(f, "mail_undo_bulk_action", {
    account_id: f.account_id,
    bulk_id: preview.bulk_id,
    request_id: randomUUID(),
  });
  assert.equal(undo.results.length, 2);
  assert.ok(undo.results.some((r: any) => r.status === "skipped"));
  f.state.close();
});
test("derived reply recipients and malformed attachment payloads are validated before any new write or send", async () => {
  const f = await setup();
  const ref = await f.imap.appendRaw(
    null,
    "INBOX",
    Buffer.from(
      "From: sender@example.com\r\nReply-To: invalid-address\r\nTo: test@example.com\r\nMessage-ID: <origin@example.com>\r\nSubject: hello\r\n\r\nbody",
    ),
    [],
  );
  const message_ref = f.refs.encode("hub-message", {
    backend: "icloud",
    account: "primary",
    folder: "INBOX",
    ref,
  });
  const writes = f.imap.appends;
  await assert.rejects(
    run(f, "mail_reply_to_message", {
      account_id: f.account_id,
      message_ref,
      text: "reply",
      mode: "draft",
      request_id: randomUUID(),
    }),
    { code: "INVALID_INPUT" },
  );
  assert.equal(f.imap.appends, writes);
  assert.equal(f.sent.length, 0);
  assert.throws(() =>
    f.m.tools.mail_save_draft.schema.parse({
      account_id: f.account_id,
      attachments: [
        { filename: "a.txt", content_type: "text/plain", base64: "invalid!" },
      ],
      request_id: randomUUID(),
    }),
  );
  f.state.close();
});
test("forwarding preserves HTML-only originals and attachments; booking extraction returns structured evidence without writes", async () => {
  const f = await setup();
  const { default: Composer } =
    await import("nodemailer/lib/mail-composer/index.js");
  const source = await new Composer({
    from: "sender@example.com",
    to: f.cfg.sender_address,
    messageId: "<original@example.com>",
    subject: "Booking",
    html: '<p>HTML only original</p><script type="application/ld+json">{"@type":"Event","name":"Conference","startDate":"2026-12-01T10:00:00+09:00","endDate":"2026-12-01T11:00:00+09:00"}</script>',
    attachments: [
      { filename: "ticket.txt", content: "ticket", contentType: "text/plain" },
      {
        filename: "event.ics",
        content:
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:booking-1\r\nSUMMARY:Calendar booking\r\nDTSTART:20261202T010000Z\r\nDTEND:20261202T020000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        contentType: "text/calendar",
      },
    ],
    disableFileAccess: true,
    disableUrlAccess: true,
  })
    .compile()
    .build();
  const ref = await f.imap.appendRaw(null, "INBOX", source, []);
  const message_ref = f.refs.encode("hub-message", {
    backend: "icloud",
    account: "primary",
    folder: "INBOX",
    ref,
  });
  const before = f.imap.appends;
  const extracted = await run(f, "mail_extract_bookings", {
    account_id: f.account_id,
    message_ref,
  });
  assert.equal(extracted.candidates.length, 2);
  assert.equal(extracted.candidates[0].start, "2026-12-01T10:00:00+09:00");
  assert.equal(extracted.candidates[1].event.title, "Calendar booking");
  assert.equal(extracted.calendar_created, false);
  assert.equal(f.imap.appends, before);
  const forwarded = await run(f, "mail_forward_message", {
    account_id: f.account_id,
    message_ref,
    to: ["recipient@example.com"],
    text: "See below",
    request_id: randomUUID(),
  });
  const target = f.refs.decode<any>(
    "hub-message",
    forwarded.resource.message_ref,
  );
  const parsed = await simpleParser(
    (await f.imap.raw(null, target.ref)).source,
  );
  assert.equal(parsed.attachments.length, 2);
  assert.match(String(parsed.html), /HTML only original/);
  assert.match(parsed.text ?? "", /HTML only original/);
  assert.ok(parsed.references?.includes("<original@example.com>"));
  f.state.close();
});

async function seed(
  f: any,
  folder: string,
  id: string,
  from: string,
  to: string,
  parent?: string,
) {
  const source = Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nMessage-ID: <${id}@example.com>\r\n${parent ? `In-Reply-To: <${parent}@example.com>\r\n` : ""}Subject: Same subject\r\n\r\nbody`,
  );
  const ref = await f.imap.appendRaw(null, folder, source, []);
  return f.refs.encode("hub-message", {
    backend: "icloud",
    account: "primary",
    folder,
    ref,
  });
}
test("thread discovery follows long reply-only chains across Inbox and Sent without subject-based joins", async () => {
  const f = await setup();
  let target = "";
  for (let i = 0; i < 12; i++)
    target = await seed(
      f,
      i % 2 ? "Sent" : "INBOX",
      `chain-${i}`,
      i % 2 ? f.cfg.sender_address : "client@example.com",
      i % 2 ? "client@example.com" : f.cfg.sender_address,
      i ? `chain-${i - 1}` : undefined,
    );
  const unrelated = await seed(
    f,
    "INBOX",
    "unrelated",
    "other@example.com",
    f.cfg.sender_address,
  );
  const first = await run(f, "mail_get_thread", {
    account_id: f.account_id,
    message_ref: target,
    limit: 5,
  });
  assert.equal(first.messages.length, 5);
  assert.equal(first.complete, false);
  assert.ok(first.next_cursor);
  const all = [...first.messages];
  let cursor = first.next_cursor;
  while (cursor) {
    const page = await run(f, "mail_get_thread", {
      account_id: f.account_id,
      message_ref: target,
      limit: 5,
      cursor,
    });
    all.push(...page.messages);
    cursor = page.next_cursor;
  }
  assert.equal(all.length, 12);
  assert.ok(all.some((x) => x.message_ref === target));
  assert.ok(!all.some((x) => x.message_ref === unrelated));
  f.state.close();
});
test("correspondents include sent-only recipients and awaiting-reply excludes answered messages", async () => {
  const f = await setup();
  const answered = await seed(
    f,
    "Sent",
    "answered",
    f.cfg.sender_address,
    "client@example.com",
  );
  await seed(
    f,
    "INBOX",
    "reply",
    "client@example.com",
    f.cfg.sender_address,
    "answered",
  );
  const outstanding = await seed(
    f,
    "Sent",
    "outstanding",
    f.cfg.sender_address,
    '"Émilie Gómez" <emilie@example.com>',
  );
  const candidates = await run(f, "mail_find_correspondent", {
    account_id: f.account_id,
    query: "Gomez",
  });
  assert.ok(
    candidates.candidates.some((x: any) => x.email === "emilie@example.com"),
  );
  assert.ok(
    !candidates.candidates.some((x: any) => x.email === f.cfg.sender_address),
  );
  const awaiting = await run(f, "mail_list_awaiting_reply", {
    account_id: f.account_id,
  });
  assert.deepEqual(
    awaiting.candidates.map((x: any) => x.message_ref),
    [outstanding],
  );
  assert.ok(!awaiting.candidates.some((x: any) => x.message_ref === answered));
  assert.equal(awaiting.heuristic, true);
  f.state.close();
});
test("change pages freeze a complete snapshot across restart and advance the checkpoint only after the final page", async () => {
  const f = await setup();
  const original = await seed(
    f,
    "INBOX",
    "first",
    "client@example.com",
    f.cfg.sender_address,
  );
  await seed(f, "INBOX", "second", "other@example.com", f.cfg.sender_address);
  const first = await run(f, "mail_list_changes", {
    account_id: f.account_id,
    limit: 1,
  });
  assert.equal(first.changes.length, 1);
  assert.equal(first.checkpoint_advanced, false);
  assert.equal(first.change_token, null);
  assert.ok(first.next_cursor);
  await seed(f, "INBOX", "later", "later@example.com", f.cfg.sender_address);
  let scans = 0;
  const search = f.imap.search.bind(f.imap);
  f.imap.search = async () => {
    scans++;
    throw new Error("Frozen continuation must not rescan");
  };
  const reopened = new HubState(join(f.dir, "ops.sqlite"));
  const old = f.state;
  f.m = new MailModule(
    f.cfg,
    f.imap as any,
    {} as any,
    {
      call: async () => {
        throw new Error("unexpected");
      },
    },
    f.refs,
    reopened,
    f.approvals,
  );
  f.state = reopened;
  old.close();
  const last = await run(f, "mail_list_changes", {
    account_id: f.account_id,
    limit: 1,
    cursor: first.next_cursor,
  });
  assert.equal(scans, 0);
  assert.equal(last.changes.length, 1);
  assert.equal(last.checkpoint_advanced, true);
  assert.ok(last.change_token);
  assert.equal(last.next_cursor, null);
  f.imap.search = search;
  const updated = await run(f, "mail_list_changes", {
    account_id: f.account_id,
    limit: 100,
    change_token: last.change_token,
  });
  assert.equal(updated.changes.length, 1);
  assert.equal(updated.checkpoint_advanced, true);
  const r = f.refs.decode<any>("hub-message", original);
  f.imap.rows.get(f.imap.key(r.ref))!.flags.push("\\Flagged");
  const flagged = await run(f, "mail_list_changes", {
    account_id: f.account_id,
    change_token: updated.change_token,
  });
  assert.equal(flagged.changes[0].message_ref, original);
  await assert.rejects(
    run(f, "mail_list_changes", {
      account_id: f.account_id,
      subject: "different",
      change_token: flagged.change_token,
    }),
    { code: "STALE_REFERENCE" },
  );
  f.state.close();
});
test("incomplete message metadata cannot advance a checkpoint or turn unreadable rows into confirmed removals", async () => {
  const f = await setup();
  await seed(f, "INBOX", "first", "client@example.com", f.cfg.sender_address);
  const baseline = await run(f, "mail_list_changes", {
    account_id: f.account_id,
  });
  assert.equal(baseline.checkpoint_advanced, true);
  f.imap.changes = async () => [];
  const partial = await run(f, "mail_list_changes", {
    account_id: f.account_id,
    change_token: baseline.change_token,
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.checkpoint_advanced, false);
  assert.equal(partial.change_token, baseline.change_token);
  assert.deepEqual(partial.missing_from_snapshot, []);
  assert.equal(partial.missing_unconfirmed.length, 1);
  const uncommitted = f.state
    .entries<any>("mail-changes:")
    .find((x) => x.value.complete === false)!;
  const unissued = f.refs.encode("mail-changes", {
    key: uncommitted.key.slice("mail-changes:".length),
  });
  await assert.rejects(
    run(f, "mail_list_changes", {
      account_id: f.account_id,
      change_token: unissued,
    }),
    { code: "STALE_REFERENCE" },
  );
  f.state.close();
});
test("change checkpoint expiry and mailbox identity changes require a new baseline", async () => {
  const f = await setup();
  const message = await seed(
    f,
    "INBOX",
    "first",
    "client@example.com",
    f.cfg.sender_address,
  );
  const baseline = await run(f, "mail_list_changes", {
    account_id: f.account_id,
  });
  const ref = f.refs.decode<any>("hub-message", message),
    replacement = f.refs.encode("hub-message", {
      ...ref,
      ref: { ...ref.ref, uidvalidity: "2" },
    });
  const { MailChanges } = await import("../src/services/mail-changes.js");
  const tracker = new MailChanges(f.cfg, f.refs, f.state);
  const input = {
    account_id: f.account_id,
    limit: 50,
    change_token: baseline.change_token,
  };
  assert.throws(
    () =>
      tracker.capture(
        f.ctx,
        input,
        [{ message_ref: replacement, fingerprint: "changed" }],
        tracker.previous(f.ctx, input),
        true,
        "selected_server_folders",
      ),
    { code: "STALE_REFERENCE" },
  );
  const key = f.refs.decode<any>("mail-changes", baseline.change_token).key,
    value = f.state.get<any>(`mail-changes:${key}`);
  f.state.put(`mail-changes:${key}`, { ...value, expires: Date.now() - 1 });
  await assert.rejects(run(f, "mail_list_changes", input), {
    code: "STALE_REFERENCE",
  });
  f.state.close();
});
test("search drops unexpected fetched UIDs instead of expanding the selected match set", async () => {
  const f = await setup();
  const selected = await seed(
      f,
      "INBOX",
      "selected",
      "client@example.com",
      f.cfg.sender_address,
    ),
    other = await seed(
      f,
      "INBOX",
      "other",
      "other@example.com",
      f.cfg.sender_address,
    );
  const selectedRef = f.refs.decode<any>("hub-message", selected),
    otherRef = f.refs.decode<any>("hub-message", other);
  f.imap.search = async () => ({
    uidvalidity: "1",
    uids: [selectedRef.ref.uid],
  });
  const original = f.imap.summaries.bind(f.imap);
  f.imap.summaries = async (ctx, folder, uv, uids) => [
    ...(await original(ctx, folder, uv, uids)),
    await f.imap.read(ctx, otherRef.ref),
  ];
  const result = await run(f, "mail_search_messages", {
    account_id: f.account_id,
    from: "client@example.com",
  });
  assert.deepEqual(
    result.messages.map((m: any) => m.message_ref),
    [selected],
  );
  assert.equal(result.complete, false);
  assert.ok(result.warnings.length);
  f.state.close();
});
