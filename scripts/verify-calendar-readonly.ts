// Bounded, read-only acceptance. Never creates/updates/deletes events or connects Mail.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { defaultDirectory, loadConfig } from "../src/core/config.js";
const directory = defaultDirectory(),
  config = await loadConfig(directory);
if (!config) throw new Error("Configure the local account first.");
const client = new Client({
  name: "apple2agent-readonly-acceptance",
  version: "1",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
    "serve",
    "--profile",
    "calendar",
  ],
  env: {
    ...(process.env as Record<string, string>),
    APPLE2AGENT_DATA_DIR: directory,
    DEBUG: "",
  },
  stderr: "pipe",
});
transport.stderr?.resume();
const report: any = {
  timestamp: new Date().toISOString(),
  transport: "official MCP SDK stdio",
  profile: "calendar",
  writes: 0,
  mail_accessed: false,
  steps: [],
};
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 40000,
  });
  const v = r.structuredContent as any;
  if (r.isError) throw new Error(v?.error?.code ?? "TOOL_FAILED");
  return v;
}
try {
  await client.connect(transport);
  report.steps.push({
    operation: "tools/list",
    count: (await client.listTools()).tools.length,
  });
  const status = await call("apple_status");
  report.steps.push({
    operation: "apple_status",
    caldav: status.caldav.status,
    calendar_count: status.caldav.calendar_count,
    mail: status.imap.status,
  });
  const calendars = await call("calendar_list");
  report.steps.push({
    operation: "calendar_list",
    count: calendars.calendars.length,
  });
  const from = new Date().toISOString(),
    to = new Date(Date.now() + 7 * 86400000).toISOString();
  const events = await call("calendar_events", { from, to, limit: 20 });
  report.steps.push({
    operation: "calendar_events",
    returned: events.events.length,
    complete: events.complete,
  });
  if (events.events[0]) {
    const item = await call("calendar_get", {
      event_id: events.events[0].event_id,
    });
    report.steps.push({
      operation: "calendar_get",
      returned: true,
      has_revision: !!item.event.revision,
    });
  }
  const free = await call("calendar_find_free_time", {
    from,
    to,
    timezone: config.default_timezone,
    duration_minutes: 30,
  });
  report.steps.push({
    operation: "calendar_find_free_time",
    complete: free.complete,
    slot_count: free.slots.length,
    checked_calendar_count: free.calendar_ids.length,
  });
  report.status = "verified_live_readonly";
} catch (e) {
  report.status = "blocked";
  report.error_code =
    (e as Error).message.replace(/[^A-Z_]/g, "").slice(0, 80) ||
    "UPSTREAM_FAILED";
  process.exitCode = 1;
} finally {
  await client.close();
  await mkdir("work", { recursive: true, mode: 0o700 });
  await writeFile(
    "work/v05-live-calendar-readonly.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
}
