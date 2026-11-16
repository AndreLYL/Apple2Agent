import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { ProcessNativeBridge, nativeExecutable } from "./native.js";
import { KeychainCredentialStore } from "./credentials.js";
import { allCapabilities, type AccessContext } from "./context.js";
import type { Config } from "./config.js";
import { CardDAVAdapter } from "../adapters/carddav.js";
import { AppError } from "./errors.js";
export async function localWindow(
  binary: string,
  input: unknown,
  signal: AbortSignal,
) {
  return new Promise<any>((resolve, reject) => {
    const p = spawn(nativeExecutable(binary), [], {
      stdio: ["pipe", "pipe", "ignore"],
      signal,
    });
    let raw = "";
    p.stdout.on("data", (b) => {
      if (raw.length < 1024 * 1024) raw += b.toString();
    });
    p.on("error", () =>
      reject(
        new AppError("HELPER_UNAVAILABLE", "The native window could not open."),
      ),
    );
    p.on("close", (code) => {
      if (code !== 0)
        return reject(
          new AppError(
            code === 20 ? "CANCELLED" : "NATIVE_ERROR",
            "Local configuration was not saved.",
          ),
        );
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError("NATIVE_ERROR", "Invalid native window result."));
      }
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(input));
  });
}
export async function configureModule(
  config: Config,
  directory: string,
  module: string,
) {
  const ctx: AccessContext = {
    owner_id: config.owner_id,
    account_id: config.account_id,
    actor_id: "trusted-local-setup",
    capabilities: new Set(allCapabilities),
    signal: AbortSignal.timeout(60000),
    grants: config.hub,
  };
  const native = new ProcessNativeBridge();
  const choices: { kind: string; id: string; label: string }[] = [];
  const add = (kind: string, id: string, label: string) =>
    choices.push({ kind, id, label });
  if (module === "reminders") {
    const r = await native.call<any>(ctx, "reminders", "discover", {});
    for (const s of r.sources)
      add("reminder_sources", s.id, `允许在来源中新建清单：${s.name}`);
    for (const l of r.lists)
      add(
        "reminder_lists",
        l.id,
        `任务清单：${l.account} / ${l.name}${l.writable ? "" : "（只读）"}`,
      );
  } else if (module === "notes") {
    const r = await native.call<any>(ctx, "automation", "notes_discover", {});
    for (const a of r.accounts)
      add("notes_accounts", a.id, `允许在账户中新建文件夹：${a.name}`);
    for (const f of r.folders)
      add("notes_folders", f.id, `笔记文件夹：${f.name}`);
  } else if (module === "mail") {
    const r = await native.call<any>(ctx, "automation", "mail_discover", {});
    if (config.imap_username)
      add(
        "mail_accounts",
        "icloud:primary",
        "独立 iCloud IMAP/SMTP（真实邮箱验收仍暂缓）",
      );
    for (const a of r.accounts)
      add("mail_accounts", a.id, `Mail：${a.name}（${a.emails.join(", ")}）`);
    for (const c of config.hub?.mail_connections ?? [])
      add("mail_accounts", `imap:${c.id}`, `独立 IMAP/SMTP：${c.name}`);
  } else if (module === "contacts") {
    const creds = new KeychainCredentialStore(
      fileURLToPath(new URL("../../bin/keychain-helper", import.meta.url)),
    );
    const r = await new CardDAVAdapter(config, creds).books(ctx);
    for (const b of r)
      add("addressbooks", b.url, `iCloud 联系人地址簿：${b.name}`);
  } else if (module === "drive") {
    const roots = [
      ...new Set([
        join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs"),
        ...(config.hub?.drive_roots ?? []),
      ]),
    ];
    for (const path of roots) add("drive_roots", path, `文件根：${path}`);
  } else if (module === "messages") {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(join(homedir(), "Library", "Messages", "chat.db"), {
        readOnly: true,
      });
      db.exec("PRAGMA query_only=ON");
    } catch {
      throw new AppError(
        "PERMISSION_DENIED",
        "Messages setup needs Full Disk Access for the actual host.",
      );
    }
    try {
      const rows = db
        .prepare(
          "SELECT ROWID AS rowid,guid,display_name,service_name FROM chat LIMIT 1000",
        )
        .all() as any[];
      const handles = new Set<string>();
      for (const c of rows) {
        const people = (
          db
            .prepare(
              "SELECT h.id FROM handle h JOIN chat_handle_join j ON j.handle_id=h.ROWID WHERE j.chat_id=?",
            )
            .all(c.rowid) as any[]
        ).map((r) => r.id);
        if (!people.length || people.some((p) => !/@|^\+\d{6}/.test(p)))
          continue;
        add(
          "message_chats",
          c.guid,
          `${c.service_name}：${c.display_name || people.join(", ")}`,
        );
        if (c.service_name === "iMessage")
          people.forEach((h) => handles.add(h));
      }
      for (const h of handles)
        add(
          "message_recipients",
          h,
          `允许审核后向这个精确身份发 iMessage：${h}`,
        );
    } finally {
      db.close();
    }
  } else
    throw new AppError(
      "INVALID_INPUT",
      "Choose reminders, notes, mail, contacts, drive or messages.",
    );
  if (!choices.length)
    throw new AppError(
      "NOT_READY",
      "No selectable resources are currently available.",
    );
  return localWindow(
    "ResourcePicker",
    { config_path: join(directory, "config.json"), module, choices },
    AbortSignal.timeout(300000),
  );
}
