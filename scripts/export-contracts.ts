// Export real MCP discovery against an isolated, credential-free test configuration.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const dir = await mkdtemp(join(tmpdir(), "a2a-contracts-"));
const config = {
  version: 1,
  owner_id: randomUUID(),
  account_id: randomUUID(),
  credential_ref: randomUUID(),
  ref_key: randomBytes(32).toString("base64"),
  apple_account: "fixture@example.com",
  imap_username: "",
  sender_address: "",
  caldav_username: "fixture@example.com",
  caldav_base_url: "https://caldav.icloud.com/",
  imap_host: "imap.mail.me.com",
  imap_port: 993,
  default_timezone: "Asia/Tokyo",
  writable_calendar_ids: [],
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
await writeFile(join(dir, "config.json"), JSON.stringify(config), {
  mode: 0o600,
});
const client = new Client({ name: "contract-export", version: "1" }),
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "serve",
      "--profile",
      "all",
    ],
    env: {
      ...(process.env as Record<string, string>),
      APPLE2AGENT_DATA_DIR: dir,
      DEBUG: "",
    },
    stderr: "pipe",
  });
transport.stderr?.resume();
try {
  await client.connect(transport);
  const result = await client.listTools();
  await mkdir("work", { recursive: true, mode: 0o700 });
  await writeFile(
    "work/v05-mcp-contracts.json",
    JSON.stringify(
      {
        version: "0.5.0-dev.2",
        profile: "all",
        configuration:
          "all modules enabled in an isolated fixture; no real resources",
        count: result.tools.length,
        tools: result.tools,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      tools: result.tools.length,
      export: "work/v05-mcp-contracts.json",
      real_resources_accessed: false,
    }),
  );
} finally {
  await client.close();
}
