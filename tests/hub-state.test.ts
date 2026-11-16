import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubState } from "../src/core/hub-state.js";
import { ApprovalStore } from "../src/core/approvals.js";
import { profileCapabilities, requireGrant } from "../src/core/context.js";
import { fixture } from "./fixtures.js";
import { References } from "../src/core/references.js";

test("resource references contain only stable identity, never configuration or signing material", () => {
  const f = fixture();
  const refs = new References(f.cfg, f.cfg.ref_key);
  const before = refs.encode("calendar", "https://caldav.icloud.com/test/");
  f.cfg.default_calendar_id = "changed";
  assert.equal(
    refs.encode("calendar", "https://caldav.icloud.com/test/"),
    before,
  );
  const payload = JSON.parse(
    Buffer.from(before.split(".")[1]!, "base64url").toString(),
  );
  assert.deepEqual(Object.keys(payload).sort(), [
    "account_id",
    "data",
    "kind",
    "owner_id",
    "v",
  ]);
  assert.equal(JSON.stringify(payload).includes(f.cfg.ref_key), false);
  f.operations.close();
});

test("trusted profiles and resource grants cannot widen read-only permissions", () => {
  assert.deepEqual(
    [...profileCapabilities("legacy")],
    ["calendar:read", "calendar:create", "mail:read", "mail:draft:create"],
  );
  assert.ok(
    [...profileCapabilities("readonly")].every((c) => c.endsWith(":read")),
  );
  const f = fixture();
  assert.throws(() => requireGrant(f.ctx, "mail_accounts", "other"), {
    code: "PERMISSION_DENIED",
  });
  requireGrant(
    { ...f.ctx, grants: { mail_accounts: ["one"] } },
    "mail_accounts",
    "one",
  );
  f.operations.close();
});
test("durable write receipts survive restart, changed payloads conflict, unknown writes only verify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-hub-")),
    path = join(dir, "state.sqlite");
  const f = fixture();
  let s = new HubState(path),
    writes = 0,
    exists = false;
  const task = {
    prepare: async () => {},
    write: async () => {
      writes++;
      exists = true;
      throw new Error("lost receipt");
    },
    verify: async () => (exists ? { id: "stable" } : undefined),
  };
  const id = randomUUID();
  await assert.rejects(s.write(f.ctx, "test", id, { x: 1 }, task), {
    code: "OUTCOME_UNKNOWN",
  });
  s.close();
  s = new HubState(path);
  assert.equal(
    (await s.write(f.ctx, "test", id, { x: 1 }, task)).replayed,
    true,
  );
  assert.equal(writes, 1);
  await assert.rejects(s.write(f.ctx, "test", id, { x: 2 }, task), {
    code: "REQUEST_CONFLICT",
  });
  s.close();
  f.operations.close();
});
test("account leases serialize shared stores and failed work releases the lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-lock-")),
    path = join(dir, "state.sqlite");
  const a = new HubState(path),
    b = new HubState(path),
    f = fixture();
  let active = 0,
    peak = 0;
  const work = async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
  };
  await Promise.all([
    a.locked(f.ctx, "calendar", work),
    b.locked(f.ctx, "calendar", work),
  ]);
  assert.equal(peak, 1);
  await assert.rejects(
    a.locked(f.ctx, "calendar", async () => {
      throw new Error("stop");
    }),
  );
  await b.locked(f.ctx, "calendar", async () => {});
  a.close();
  b.close();
  f.operations.close();
});
test("approvals encrypt payloads, require trusted review and release once across callers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-approval-")),
    path = join(dir, "state.sqlite");
  const state = new HubState(path),
    f = fixture(),
    key = randomBytes(32);
  const approvals = new ApprovalStore(state, f.cfg, async () => key);
  const action = await approvals.request(
    f.ctx,
    "mail_send",
    randomUUID(),
    "mail:send",
    { body: "private-payload-marker" },
  );
  assert.equal(action.status, "queued_for_approval");
  await assert.rejects(
    approvals.execute(f.ctx, action.action_id, "mail_send", async () => {}),
    { code: "APPROVAL_REQUIRED" },
  );
  const raw = Buffer.concat([
    await readFile(path),
    await readFile(path + "-wal"),
  ]);
  assert.equal(raw.includes(Buffer.from("private-payload-marker")), false);
  await approvals.review(
    f.ctx,
    action.action_id,
    async (op, payload) =>
      op === "mail_send" && (payload as any).body === "private-payload-marker",
  );
  let calls = 0;
  const send = async () => {
    calls++;
    return { accepted: true };
  };
  await Promise.allSettled([
    approvals.execute(f.ctx, action.action_id, "mail_send", send),
    approvals.execute(f.ctx, action.action_id, "mail_send", send),
  ]);
  assert.equal(calls, 1);
  const denied = { ...f.ctx, capabilities: profileCapabilities("readonly") };
  assert.throws(() => approvals.status(denied, action.action_id), {
    code: "PERMISSION_DENIED",
  });
  state.close();
  f.operations.close();
});
