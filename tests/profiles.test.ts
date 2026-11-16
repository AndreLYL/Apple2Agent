import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "./fixtures.js";
import { quoteShell, runtimeSummary } from "../src/core/connector.js";
async function connect(
  profile: string,
  enabled = [
    "calendar",
    "mail",
    "reminders",
    "contacts",
    "notes",
    "drive",
    "messages",
  ],
) {
  const dir = await mkdtemp(join(tmpdir(), "a2a-profile-")),
    cfg = { ...config(), hub: { enabled_modules: enabled } };
  await writeFile(join(dir, "config.json"), JSON.stringify(cfg), {
    mode: 0o600,
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "serve",
      "--profile",
      profile,
    ],
    env: {
      ...(process.env as Record<string, string>),
      APPLE2AGENT_DATA_DIR: dir,
      DEBUG: "",
    },
    stderr: "pipe",
  });
  transport.stderr?.resume();
  const client = new Client({ name: "profile-test", version: "1" });
  await client.connect(transport);
  return { client, transport };
}
test("real stdio all/calendar/readonly profiles publish strict selected module contracts", async () => {
  for (const profile of ["all", "calendar", "readonly"]) {
    const { client } = await connect(profile);
    try {
      const tools = (await client.listTools()).tools,
        names = tools.map((t) => t.name);
      assert.ok(names.includes("calendar_events"));
      if (profile === "calendar") {
        assert.equal(names.length, 9);
        assert.ok(
          names.every((n) => n === "apple_status" || n.startsWith("calendar_")),
        );
      } else if (profile === "all") {
        for (const n of [
          "mail_send_message",
          "reminders_complete_reminder",
          "contacts_update_group",
          "notes_update_note",
          "drive_trash_item",
          "imessage_send_message",
        ])
          assert.ok(names.includes(n), n);
        const result = await client.callTool({
          name: "mail_send_message",
          arguments: {
            account_id: "invalid",
            to: ["a@example.com"],
            subject: "test",
            text: "test",
            request_id: "00000000-0000-4000-a000-000000000000",
            approved: true,
          },
        });
        assert.equal(result.isError, true);
        assert.ok(
          result.structuredContent
            ? (result.structuredContent as any).error.code === "INVALID_INPUT"
            : JSON.stringify(result.content).includes("approved"),
        );
      } else {
        assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
        assert.ok(!names.includes("apple_action_discard"));
      }
    } finally {
      await client.close();
    }
  }
});
test("connector shell quoting preserves exact executable and path arguments", () => {
  assert.equal(quoteShell("a'b $(unsafe)"), "'a'\\''b $(unsafe)'");
});
test("changing the local configuration invalidates existing contexts and cached approvals until reconnect", async () => {
  const { createApplication } = await import("../src/app.js");
  const { authorize } = await import("../src/core/context.js");
  const dir = await mkdtemp(join(tmpdir(), "a2a-revoke-")),
    cfg = config();
  cfg.hub = {
    enabled_modules: ["calendar", "mail"],
    mail_accounts: ["icloud:primary"],
  };
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(cfg), { mode: 0o600 });
  const app = createApplication(cfg, dir, { profile: "all" }),
    ctx = app.context(AbortSignal.timeout(30000));
  authorize(ctx, cfg, "mail:send");
  await writeFile(
    path,
    JSON.stringify({ ...cfg, hub: { ...cfg.hub, mail_accounts: [] } }, null, 2),
    { mode: 0o600 },
  );
  assert.throws(() => authorize(ctx, cfg, "mail:send"), {
    code: "CONFIGURATION_CHANGED",
  });
  assert.throws(() => app.context(AbortSignal.timeout(30000)), {
    code: "CONFIGURATION_CHANGED",
  });
  app.close();
});

test("connector diagnostics return only typed readiness and known states, never raw client config or logs", () => {
  const marker = "private-runtime-marker";
  const r = runtimeSummary({
    running: { key: marker },
    healthy: true,
    ready: marker,
    status: { key: marker },
    config: { runtime_api_key: marker },
    logs: marker,
  });
  assert.deepEqual(r, {
    running: null,
    healthy: true,
    ready: null,
    status: null,
  });
  assert.equal(JSON.stringify(r).includes(marker), false);
  assert.equal(
    runtimeSummary({
      runtime: { running: true, ready: false },
      status: "starting",
    }).status,
    "starting",
  );
});

test("connector status recognizes the official native runtime process_running contract", () => {
  assert.deepEqual(
    runtimeSummary({
      process_running: true,
      healthy: true,
      ready: false,
      runtime_state: "starting",
      remote_lookup_auth_ref: "private-key-reference",
      process: { environment: { CONTROL_PLANE_API_KEY: "private-key" } },
    }),
    { running: true, healthy: true, ready: false, status: "starting" },
  );
  assert.equal(
    runtimeSummary({ process_running: false, running: true }).running,
    false,
  );
  assert.equal(
    runtimeSummary({ runtime: { process_running: true } }).running,
    true,
  );
});

test("local calendar-access command changes scope without replacing the default or selected calendars", async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { config } = await import("./fixtures.js");
  const directory = await mkdtemp(join(tmpdir(), "a2a-access-cli-")),
    cfg = config();
  cfg.default_calendar_id = "existing-default";
  cfg.writable_calendar_ids = ["existing-selection"];
  await writeFile(join(directory, "config.json"), JSON.stringify(cfg), {
    mode: 0o600,
  });
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "calendar-access", "all-writable"],
    {
      cwd: process.cwd(),
      env: { ...process.env, APPLE2AGENT_DATA_DIR: directory },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(
    await readFile(join(directory, "config.json"), "utf8"),
  );
  assert.equal(saved.calendar_write_scope, "all_writable");
  assert.equal(saved.default_calendar_id, "existing-default");
  assert.deepEqual(saved.writable_calendar_ids, ["existing-selection"]);
});
