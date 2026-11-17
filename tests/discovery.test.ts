import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApplication } from "../src/app.js";
import { createServer } from "../src/mcp/server.js";
import { toolDescriptions } from "../src/core/tool-descriptions.js";
import type { Profile } from "../src/core/context.js";
import { config } from "./fixtures.js";

// Captured from public 0.5.0-alpha.1 (8b3444c), before discovery text changes.
// Hashes cover ordered names and complete JSON input schemas, including defaults.
const baseline = {
  legacy: {
    count: 8,
    hash: "e4623b55dca3d712d03c5bd6854c0cef0a276673f1a334edeabfb700af2c4fc7",
  },
  calendar: {
    count: 9,
    hash: "26848f88687c7862ea51302c1e8bcd7122a98ee522dd054de655c57e15fde596",
  },
  readonly: {
    count: 44,
    hash: "635956c0e4a37ddfda85fd7aae66764d6deddcf666f57ccae1aae97eb4c9d5c3",
  },
  all: {
    count: 91,
    hash: "0528d2ab6c5e8a0aa083fe87ed7bdd5c92f14355910473815121458c033a5685",
  },
};

async function discover(profile: Profile) {
  const directory = await mkdtemp(join(tmpdir(), "a2a-discovery-"));
  const cfg = {
    ...config(),
    hub: {
      enabled_modules: [
        "calendar",
        "mail",
        "reminders",
        "contacts",
        "notes",
        "drive",
        "messages",
      ],
    },
  };
  await writeFile(join(directory, "config.json"), JSON.stringify(cfg), {
    mode: 0o600,
  });
  const app = createApplication(cfg, directory, { profile });
  const server = createServer(app, profile);
  const client = new Client({ name: "offline-discovery-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    // Discovery only: never invoke providers, native helpers or credentials.
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
    app.close();
  }
}

test("discovery preserves every profile's names, schemas and defaults", async () => {
  for (const profile of Object.keys(baseline) as Profile[]) {
    const tools = await discover(profile);
    assert.equal(tools.length, baseline[profile].count, profile);
    const contracts = tools.map(({ name, inputSchema }) => ({
      name,
      inputSchema,
    }));
    assert.equal(
      createHash("sha256").update(JSON.stringify(contracts)).digest("hex"),
      baseline[profile].hash,
      profile,
    );
  }
});

test("all tools publish concise operation-specific descriptions and bounded discovery size", async () => {
  const tools = await discover("all");
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    Object.keys(toolDescriptions).sort(),
  );
  const normalized = new Set<string>();
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length <= 300, tool.name);
    const body = tool.description.replace(/^\S+\s+/, "");
    assert.ok(!normalized.has(body), `Template-only difference: ${tool.name}`);
    normalized.add(body);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(tools)) <= 105430);
  const description = (name: string) =>
    tools.find((t) => t.name === name)!.description!;
  for (const name of [
    "mail_send_message",
    "mail_send_draft",
    "imessage_send_message",
  ]) {
    assert.match(description(name), /[Dd]oes not send/);
    assert.match(description(name), /native review/);
  }
  for (const name of ["mail_execute_send", "imessage_execute_send"]) {
    assert.match(description(name), /[Ee]xecute.*approved.*action/);
    assert.match(description(name), /action_id/);
  }
  assert.match(description("drive_get_file"), /raw.*base64/);
  assert.match(description("drive_read_file"), /[Ee]xtract.*text/);
  assert.match(description("mail_search"), /iCloud/);
  assert.match(description("mail_search_messages"), /selected account/);
  assert.match(
    description("mail_list_changes"),
    /unchanged prior change_token/,
  );
});

test("risk hints distinguish replacement, additive preparation and local action state", async () => {
  const { toolAnnotations, writeEffects } =
    await import("../src/mcp/tool-annotations.js");
  const tools = await discover("all");
  const annotations = (name: string) =>
    tools.find((t) => t.name === name)!.annotations!;
  const writes = tools.filter((t) => !t.annotations!.readOnlyHint);
  assert.deepEqual(
    writes.map((t) => t.name).sort(),
    Object.keys(writeEffects).sort(),
  );
  for (const tool of tools.filter((t) => t.annotations!.readOnlyHint)) {
    assert.equal(tool.annotations!.destructiveHint, false, tool.name);
    assert.equal(tool.annotations!.idempotentHint, true, tool.name);
  }
  for (const name of [
    "calendar_update",
    "drive_write_file",
    "drive_move_item",
    "contacts_update_contact",
    "contacts_update_group",
    "reminders_complete_reminder",
    "reminders_update_list",
    "notes_move_note",
    "notes_update_note",
    "mail_update_draft",
    "mail_execute_send",
    "apple_action_discard",
  ]) {
    assert.equal(annotations(name).destructiveHint, true, name);
    assert.equal(annotations(name).readOnlyHint, false, name);
  }
  for (const name of [
    "calendar_create",
    "mail_create_folder",
    "notes_append_to_note",
    "mail_send_message",
    "mail_reply_to_message",
    "mail_send_draft",
    "mail_unsubscribe_from_list",
    "imessage_execute_send",
  ]) {
    assert.equal(annotations(name).destructiveHint, false, name);
    assert.equal(annotations(name).readOnlyHint, false, name);
  }
  for (const tool of writes) {
    const guard = writeEffects[tool.name]!.replay;
    assert.ok(
      Object.hasOwn(tool.inputSchema.properties!, guard),
      `${tool.name}: ${guard}`,
    );
    assert.equal(tool.annotations!.idempotentHint, true, tool.name);
  }
  for (const name of ["apple_action_status", "apple_action_discard"]) {
    assert.equal(annotations(name).openWorldHint, false, name);
  }
  for (const name of [
    "calendar_events",
    "drive_read_file",
    "mail_execute_send",
    "imessage_execute_send",
  ]) {
    assert.equal(annotations(name).openWorldHint, true, name);
  }
  assert.deepEqual(toolAnnotations("unreviewed_write", false), {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
});
