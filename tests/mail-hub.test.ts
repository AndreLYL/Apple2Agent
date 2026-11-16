import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "./fixtures.js";
import { allCapabilities, type AccessContext } from "../src/core/context.js";
import { HubState } from "../src/core/hub-state.js";
import { References } from "../src/core/references.js";
import { MailModule } from "../src/modules/mail.js";
import { MailHub, HubApprovals } from "../src/modules/mail-hub.js";
import { AdvancedIMAPAdapter } from "../src/adapters/imap-advanced.js";
test("independent protocol connections keep UID references, approval routing and revocation isolated from Mac Mail and primary iCloud", async () => {
  const cfg = config(),
    id = randomUUID();
  cfg.hub = {
    enabled_modules: ["mail"],
    mail_connections: [
      {
        id,
        name: "Provider",
        sender: "me@example.com",
        username: "me@example.com",
        credential_ref: randomUUID(),
        imap_host: "imap.example.com",
        smtp_host: "smtp.example.com",
        smtp_port: 587,
      },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), "a2a-hub-")),
    state = new HubState(join(dir, "state.sqlite")),
    refs = new References(cfg, cfg.ref_key),
    key = randomBytes(32),
    approvals = new HubApprovals(state, cfg, async () => key);
  let nativeCalls = 0,
    credentialCalls = 0;
  const credentials = {
    get: async () => {
      credentialCalls++;
      throw new Error("unexpected credential access");
    },
  };
  const native = {
    call: async () => {
      nativeCalls++;
      throw new Error("unexpected native access");
    },
  };
  const primary = new MailModule(
    cfg,
    {} as any,
    {} as any,
    native,
    refs,
    state,
    approvals,
  );
  const hub = new MailHub(
    cfg,
    primary,
    credentials as any,
    native,
    state,
    approvals,
    async () => key,
  );
  approvals.mailHub = hub;
  const ctx: AccessContext = {
    owner_id: cfg.owner_id,
    account_id: cfg.account_id,
    actor_id: "test",
    capabilities: new Set(allCapabilities),
    grants: { mail_accounts: [`imap:${id}`] },
    signal: AbortSignal.timeout(30000),
  };
  const accounts = await hub.tools.mail_list_accounts!.run(ctx, {});
  assert.equal(accounts.accounts.length, 1);
  assert.equal(accounts.accounts[0].backend, "imap-smtp");
  assert.equal(nativeCalls, 0);
  assert.equal(credentialCalls, 0);
  const scope = hub.scopes[0]!,
    scoped = hub.scopeContext(ctx, scope);
  const action = await scope.approvals.request(
    scoped,
    "mail_send",
    randomUUID(),
    "mail:send",
    {
      summary: { text: "immutable" },
      authorization_grants: [{ kind: "mail_accounts", id: "icloud:primary" }],
    },
  );
  await approvals.review(ctx, action.action_id, async () => true);
  assert.equal(approvals.status(ctx, action.action_id).status, "approved");
  const wrongRef = refs.encode("hub-message", {
    backend: "icloud",
    account: "primary",
    folder: "INBOX",
    ref: { folder: "INBOX", uidvalidity: "1", uid: 1 },
  });
  await assert.rejects(
    hub.tools.mail_get_message!.run(ctx, {
      account_id: accounts.accounts[0].mail_account_id,
      message_ref: wrongRef,
    }),
    { code: "STALE_REFERENCE" },
  );
  ctx.grants = { mail_accounts: [] };
  assert.throws(() => approvals.status(ctx, action.action_id), {
    code: "PERMISSION_DENIED",
  });
  state.close();
});
test("protocol hosts are accepted only through trusted local provider configuration, with TLS retained", async () => {
  const cfg = config();
  cfg.imap_host = "imap.example.com";
  let options: any;
  const fake: any = {
    on() {},
    async connect() {},
    async list() {
      return [];
    },
    close() {},
  };
  const credentials = { get: async () => "test-app-password" },
    ctx: AccessContext = {
      owner_id: cfg.owner_id,
      account_id: cfg.account_id,
      actor_id: "test",
      capabilities: new Set(allCapabilities),
      signal: AbortSignal.timeout(30000),
    };
  const factory = (o: any) => {
    options = o;
    return fake;
  };
  await assert.rejects(
    new AdvancedIMAPAdapter(cfg, credentials, factory).folders(ctx),
    { code: "ENDPOINT_UNSUPPORTED" },
  );
  await new AdvancedIMAPAdapter(cfg, credentials, factory, true).folders(ctx);
  assert.equal(options.host, "imap.example.com");
  assert.equal(options.port, 993);
  assert.equal(options.secure, true);
  assert.equal(options.logger, false);
});
