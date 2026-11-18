#!/usr/bin/env node
import { maintenance } from "./core/maintenance.js";
import { VERSION } from "./core/version.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadConfig,
  initializeConfig,
  defaultDirectory,
  saveConfig,
} from "./core/config.js";
import { z } from "zod";
import { ProcessNativeBridge } from "./core/native.js";
import { configureModule, localWindow } from "./core/setup-modules.js";
import { connector } from "./core/connector.js";
import { safeError, AppError } from "./core/errors.js";
import { createApplication } from "./app.js";
import {
  createServer,
  invoke,
  toolSchemas,
  type AnyToolName,
} from "./mcp/server.js";
import { schemas, type ToolName } from "./core/schemas.js";
const directory = defaultDirectory();
const helper = fileURLToPath(
  new URL("../bin/keychain-helper", import.meta.url),
);
async function runHelper(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(helper, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new AppError(
              "NOT_CONFIGURED",
              code === 20
                ? "Setup was cancelled."
                : "Native configuration failed.",
              "Rerun apple2agent setup.",
            ),
          ),
    );
  });
}
async function main() {
  const command = process.argv[2] ?? "serve";
  const profileAt = process.argv.indexOf("--profile");
  const profile = z
    .enum(["legacy", "calendar", "all", "readonly"])
    .parse(
      profileAt >= 0
        ? process.argv[profileAt + 1]
        : ["review", "configure", "module-status", "serve", "tool"].includes(
              command,
            )
          ? "all"
          : "legacy",
    );
  if (command === "--version") {
    console.log(VERSION);
    return;
  }
  if (command === "--help") {
    console.log(
      "Apple2Agent\n  serve [--profile legacy|calendar|all|readonly]\n  setup\n  configure MODULE\n  module-status MODULE [--profile all]\n  review ACTION_ID\n  link-mail-provider\n  maintenance\n  connector-configure\n  connector-connect\n  connector-status\n  configure-mail ADDRESS\n  doctor\n  select-calendar\n  calendar-access [selected|all-writable]\n  sms-read-access [selected|all-sms]\n  tool NAME JSON [--profile PROFILE]\n\nSecrets are entered only in the native setup window.",
    );
    return;
  }
  if (command === "setup") {
    await initializeConfig(directory);
    await runHelper(["setup", join(directory, "config.json")]);
  }
  const config = await loadConfig(directory);
  if (command === "calendar-access") {
    if (!config) throw new AppError("NOT_CONFIGURED", "Run setup first.");
    const choice = z.enum(["selected", "all-writable"]).parse(process.argv[3]);
    config.calendar_write_scope =
      choice === "all-writable" ? "all_writable" : "selected";
    await saveConfig(directory, config);
    console.log(
      JSON.stringify({
        calendar_write_scope: config.calendar_write_scope,
        default_calendar_unchanged: true,
        next_action:
          "Reconnect MCP to load this write scope. Apple read-only calendars remain protected.",
      }),
    );
    return;
  }
  if (command === "sms-read-access") {
    if (!config?.hub?.enabled_modules.includes("messages"))
      throw new AppError(
        "NOT_CONFIGURED",
        "Enable Messages in local setup first.",
      );
    const mode = z.enum(["selected", "all-sms"]).parse(process.argv[3]);
    config.hub.sms_read_scope = mode === "all-sms" ? "all_sms" : "selected";
    await saveConfig(directory, config);
    console.log(
      JSON.stringify({
        sms_read_scope: config.hub.sms_read_scope,
        next_action: "Reconnect once to load the new read policy.",
      }),
    );
    return;
  }
  if (command === "configure-mail") {
    if (!config?.apple_account)
      throw new AppError("NOT_CONFIGURED", "Run setup first.");
    const address = z.email().max(320).parse(process.argv[3]);
    config.imap_username = address;
    config.sender_address = address;
    await saveConfig(directory, config);
    console.log(
      "iCloud mailbox address configured. Run doctor when ready to validate it.",
    );
    return;
  }
  if (command.startsWith("connector-")) {
    if (command === "connector-configure") {
      const tunnelAt = process.argv.indexOf("--tunnel-id");
      const tunnelId =
        tunnelAt < 0
          ? ""
          : z
              .string()
              .regex(/^tunnel_[\w-]{8,128}$/)
              .parse(process.argv[tunnelAt + 1]);
      const connectorProfile =
        profileAt < 0 ? "all" : z.enum(["calendar", "all"]).parse(profile);
      console.log(
        JSON.stringify(
          await localWindow(
            "TunnelPicker",
            {
              directory,
              client: "/opt/homebrew/bin/tunnel-client",
              tunnel_id: tunnelId,
              profile: connectorProfile,
            },
            AbortSignal.timeout(300000),
          ),
        ),
      );
      return;
    }
    if (command === "connector-connect" || command === "connector-status") {
      console.log(
        JSON.stringify(
          await connector(
            directory,
            command === "connector-connect" ? "connect" : "status",
          ),
          null,
          2,
        ),
      );
      return;
    }
    throw new AppError("INVALID_INPUT", "Unknown connector command.");
  }
  if (command === "link-mail-provider") {
    if (!config) throw new AppError("NOT_CONFIGURED", "Run setup first.");
    const ctx = {
      owner_id: config.owner_id,
      account_id: config.account_id,
      actor_id: "trusted-local-setup",
      capabilities: new Set<import("./core/context.js").Capability>(),
      signal: AbortSignal.timeout(60000),
    };
    const accounts = await new ProcessNativeBridge().call<any>(
      ctx,
      "automation",
      "mail_discover",
      {},
    );
    console.log(
      JSON.stringify(
        await localWindow(
          "MailProviderPicker",
          {
            config_path: join(directory, "config.json"),
            accounts: accounts.accounts,
          },
          AbortSignal.timeout(300000),
        ),
      ),
    );
    return;
  }
  if (command === "configure") {
    if (!config) throw new AppError("NOT_CONFIGURED", "Run setup first.");
    console.log(
      JSON.stringify(
        await configureModule(config, directory, process.argv[3] ?? ""),
      ),
    );
    return;
  }
  const app = config?.apple_account
    ? createApplication(config, directory, { profile })
    : undefined;
  if (command === "serve") {
    const server = createServer(
      app,
      !app && profileAt < 0 ? "legacy" : profile,
    );
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server.close().finally(() => {
        app?.close();
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdin.on("end", stop);
    await server.connect(new StdioServerTransport());
    return;
  }
  try {
    if (command === "maintenance") {
      if (!app) throw new AppError("NOT_CONFIGURED", "Run setup first.");
      console.log(
        JSON.stringify(
          await maintenance(
            directory,
            app.state,
            app.approvals,
            config?.hub?.backup_retention_days ?? 30,
          ),
        ),
      );
      return;
    }
    if (command === "prune-approvals") {
      if (!app) throw new AppError("NOT_CONFIGURED", "Run setup first.");
      console.log(JSON.stringify(app.approvals.prune()));
      return;
    }
    if (command === "review") {
      if (!app) throw new AppError("NOT_CONFIGURED", "Run setup first.");
      const ctx = app.context(AbortSignal.timeout(300000));
      const native = new ProcessNativeBridge();
      console.log(
        JSON.stringify(
          await app.approvals.review(
            ctx,
            z.string().min(1).max(16384).parse(process.argv[3]),
            async (operation, payload) => {
              const p = payload as any;
              const result = await native.call<any>(
                ctx,
                "action-approval",
                operation,
                { summary: JSON.stringify(p.summary ?? p, null, 2) },
              );
              return result.approved === true;
            },
          ),
          null,
          2,
        ),
      );
      return;
    }
    if (command === "module-status") {
      if (!app) throw new AppError("NOT_CONFIGURED", "Run setup first.");
      const m = app.modules.find((m) => m.domain === process.argv[3]);
      if (!m) throw new AppError("INVALID_INPUT", "Unknown module.");
      console.log(
        JSON.stringify(
          await m.status(app.context(AbortSignal.timeout(30000))),
          null,
          2,
        ),
      );
      return;
    }
    if (command === "doctor" || command === "setup") {
      const result = await invoke(app, "apple_status", {});
      console.log(JSON.stringify(result.structuredContent, null, 2));
      if (result.isError) process.exitCode = 1;
      return;
    }
    if (command === "select-calendar") {
      if (!app) throw new AppError("NOT_CONFIGURED", "Run setup first.");
      const result = await app.calendar.list(
        app.context(AbortSignal.timeout(30000)),
      );
      const choices = result.calendars.filter((c) => c.writable === true);
      if (!choices.length)
        throw new AppError(
          "PERMISSION_DENIED",
          "No confirmed writable calendars discovered.",
          "Run doctor and inspect CalDAV permissions.",
        );
      const path = join(directory, `calendar-choice-${randomUUID()}.json`);
      await writeFile(path, JSON.stringify(choices), {
        mode: 0o600,
        flag: "wx",
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const p = spawn(
            fileURLToPath(new URL("../bin/calendar-picker", import.meta.url)),
            [join(directory, "config.json"), path],
            { stdio: "inherit" },
          );
          p.on("error", reject);
          p.on("exit", (code) =>
            code === 0
              ? resolve()
              : reject(
                  new AppError(
                    "NOT_CONFIGURED",
                    "Calendar selection was not saved.",
                    "Run select-calendar again.",
                  ),
                ),
          );
        });
      } finally {
        await unlink(path);
      }
      console.log("Default writable calendar selected.");
      return;
    }
    if (command === "tool") {
      const name = process.argv[3] as AnyToolName;
      if (
        !Object.hasOwn(toolSchemas, name) &&
        !Object.hasOwn(app?.tools ?? {}, name)
      )
        throw new AppError("INVALID_INPUT", "Unknown tool.", "Run --help.");
      const result = await invoke(
        app,
        name,
        JSON.parse(process.argv[4] ?? "{}"),
      );
      console.log(JSON.stringify(result.structuredContent, null, 2));
      if (result.isError) process.exitCode = 1;
      return;
    }
    throw new AppError(
      "INVALID_INPUT",
      "Unknown command.",
      "Run apple2agent --help.",
    );
  } finally {
    app?.close();
  }
}
main().catch((e) => {
  process.stderr.write(JSON.stringify(safeError(e).toJSON()) + "\n");
  process.exitCode = 1;
});
