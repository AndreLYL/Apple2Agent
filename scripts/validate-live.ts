// Explicit live acceptance run. Creates ONE marked event and ONE unsent draft.
// Stable checkpoint IDs prevent duplicate test records on reruns.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Temporal } from "@js-temporal/polyfill";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultDirectory, loadConfig } from "../src/core/config.js";
const directory = defaultDirectory();
const cfg = await loadConfig(directory);
if (!cfg) throw new Error("Configure Apple2Agent first.");
const checkpointPath = join(directory, "live-acceptance.json");
let checkpoint: any;
try {
  checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
if (!checkpoint) {
  const start = Temporal.Now.zonedDateTimeISO(cfg.default_timezone)
    .add({ days: 1 })
    .with({
      hour: 10,
      minute: 0,
      second: 0,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
    });
  checkpoint = {
    calendar_request_id: randomUUID(),
    draft_request_id: randomUUID(),
    start: start.toString({ timeZoneName: "never" }),
    end: start.add({ minutes: 5 }).toString({ timeZoneName: "never" }),
    timezone: cfg.default_timezone,
  };
  await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
}
const client = new Client({
  name: "Apple2Agent-live-acceptance",
  version: "1.0.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "serve"],
  env: {
    ...(process.env as Record<string, string>),
    APPLE2AGENT_DATA_DIR: directory,
    DEBUG: "",
  },
  stderr: "pipe",
});
const report: any = {
  timestamp: new Date().toISOString(),
  client: "official MCP SDK stdio Client",
  scope: process.argv.includes("--mail")
    ? "calendar_and_mail"
    : "calendar_only",
  steps: [],
  sent_count: 0,
};
function note(step: string, data: any) {
  const entry = { step, ...data };
  report.steps.push(entry);
  console.log(JSON.stringify(entry));
}
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 40000,
  });
  const json = result.structuredContent as any;
  if (result.isError)
    throw new Error(`${name}: ${json?.error?.code ?? "tool error"}`);
  return json;
}
try {
  await client.connect(transport);
  note("tools_list", { count: (await client.listTools()).tools.length });
  const calendars = await call("calendar_list");
  note("calendar_list", { count: calendars.calendars.length });
  const from = Temporal.Now.instant();
  const events = await call("calendar_events", {
    from: from.toString(),
    to: from.add({ hours: 7 * 24 }).toString(),
    limit: 20,
  });
  note("calendar_read", {
    count: events.events.length,
    warnings: events.warnings.length,
    truncated: events.truncated,
  });
  if (process.argv.includes("--calendar")) {
    const args = {
      title: "Apple2Agent 本机接入测试（可手动删除）",
      start: checkpoint.start,
      end: checkpoint.end,
      timezone: checkpoint.timezone,
      notes: "用于验证本机 MCP 创建与回读；没有参加者，不发送邀请。",
      request_id: checkpoint.calendar_request_id,
    };
    const created = await call("calendar_create", args);
    note("calendar_create", {
      status: created.status,
      verified: created.verified,
      start: checkpoint.start,
      timezone: checkpoint.timezone,
    });
    const replay = await call("calendar_create", args);
    note("calendar_retry", {
      verified: replay.verified,
      replayed: replay.replayed,
    });
    const after = await call("calendar_events", {
      from: checkpoint.start,
      to: checkpoint.end,
      query: args.title,
      limit: 100,
    });
    note("calendar_readback", {
      matching_events: after.events.filter(
        (e: any) => e.uid === created.resource?.uid,
      ).length,
      warnings: after.warnings.length,
    });
    if (
      created.verified !== true ||
      replay.verified !== true ||
      after.events.filter((e: any) => e.uid === created.resource?.uid)
        .length !== 1
    )
      throw new Error("Calendar write/readback verification incomplete.");
  }
  if (process.argv.includes("--mail")) {
    const folders = await call("mail_folders");
    note("mail_folders", { count: folders.folders.length });
    const search = await call("mail_search", { limit: 5 });
    note("mail_search", { count: search.messages.length });
    const args = {
      subject: "Apple2Agent 本机草稿测试（未发送）",
      body_text:
        "这是一份由 Apple2Agent 本机 MCP 保存的验证草稿。\n没有收件人，未发送。可在验证后手动删除。",
      request_id: checkpoint.draft_request_id,
    };
    const draft = await call("mail_draft_create", args);
    note("draft_create", {
      status: draft.status,
      verified: draft.verified,
      sent: draft.sent,
    });
    const replay = await call("mail_draft_create", args);
    note("draft_retry", {
      verified: replay.verified,
      replayed: replay.replayed,
      sent: replay.sent,
    });
    if (
      draft.verified !== true ||
      replay.verified !== true ||
      draft.sent !== false ||
      replay.sent !== false
    )
      throw new Error("Draft verification incomplete.");
    const first = await call("mail_read", {
      message_ref: draft.resource.message_ref,
    });
    const second = await call("mail_read", {
      message_ref: draft.resource.message_ref,
    });
    note("draft_readback", {
      body_matches:
        first.body_text.replace(/\r\n/g, "\n").trimEnd() ===
        args.body_text.trimEnd(),
      unread_unchanged: first.unread === second.unread,
      draft: first.draft,
    });
    if (first.unread !== second.unread || first.draft !== true)
      throw new Error("Mail readback or flag preservation failed.");
  }
  report.completed = true;
} catch (e) {
  report.completed = false;
  report.error = (e as Error).message;
  process.exitCode = 1;
  console.log(JSON.stringify({ error: report.error }));
} finally {
  await client.close();
  await mkdir("work", { recursive: true });
  const reportPath = process.argv.includes("--mail")
    ? "work/live-full.json"
    : "work/live-calendar.json";
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}
