import { mkdir, readFile, writeFile, chmod, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors.js";
export const ConfigSchema = z
  .object({
    version: z.literal(1),
    owner_id: z.uuid(),
    account_id: z.uuid(),
    credential_ref: z.uuid(),
    ref_key: z.string().min(40),
    apple_account: z.string(),
    imap_username: z.string(),
    caldav_username: z.string(),
    sender_address: z.string(),
    caldav_base_url: z.url(),
    imap_host: z.string(),
    imap_port: z.literal(993),
    default_timezone: z.string(),
    default_calendar_id: z.string().optional(),
    calendar_write_scope: z.enum(["selected", "all_writable"]).optional(),
    writable_calendar_ids: z.array(z.string()),
    drafts_folder: z.string().optional(),
    hub: z
      .object({
        backup_retention_days: z.number().int().min(1).max(365).optional(),
        enabled_modules: z.array(
          z.enum([
            "calendar",
            "mail",
            "reminders",
            "contacts",
            "notes",
            "drive",
            "messages",
          ]),
        ),
        capabilities: z.array(z.string()).optional(),
        mail_accounts: z.array(z.string()).optional(),
        reminder_sources: z.array(z.string()).optional(),
        reminder_lists: z.array(z.string()).optional(),
        denied_reminder_lists: z.array(z.string()).optional(),
        addressbooks: z.array(z.string()).optional(),
        notes_accounts: z.array(z.string()).optional(),
        notes_folders: z.array(z.string()).optional(),
        denied_notes_folders: z.array(z.string()).optional(),
        drive_roots: z.array(z.string()).optional(),
        sms_read_scope: z.enum(["selected", "all_sms"]).optional(),
        message_chats: z.array(z.string()).optional(),
        message_recipients: z.array(z.string()).optional(),
        message_never_send: z.array(z.string()).optional(),
        default_reminder_list: z.string().optional(),
        default_reminder_source: z.string().optional(),
        default_addressbook: z.string().optional(),
        default_notes_folder: z.string().optional(),
        availability_calendar_ids: z.array(z.string()).optional(),
        approval_key_ref: z.uuid().optional(),
        contacts_base_url: z.url().optional(),
        contacts_transport: z.enum(["discovered", "frontdoor"]).optional(),
        mail_connections: z
          .array(
            z
              .object({
                id: z.uuid(),
                name: z.string().min(1).max(100),
                sender: z.email(),
                username: z.string().min(1).max(320),
                credential_ref: z.uuid(),
                imap_host: z.string().regex(/^[A-Za-z0-9.-]+$/),
                smtp_host: z.string().regex(/^[A-Za-z0-9.-]+$/),
                smtp_port: z.union([z.literal(465), z.literal(587)]),
                smtp_username: z.string().max(320).optional(),
                smtp_credential_ref: z.uuid().optional(),
                drafts_folder: z.string().optional(),
                sent_folder: z.string().optional(),
                trash_folder: z.string().optional(),
                mail_app_account_id: z.string().optional(),
              })
              .strict(),
          )
          .max(30)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
export function defaultDirectory() {
  return (
    process.env.APPLE2AGENT_DATA_DIR ??
    join(homedir(), "Library", "Application Support", "Apple2Agent")
  );
}
export async function loadConfig(
  directory: string,
): Promise<Config | undefined> {
  try {
    const path = join(directory, "config.json");
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.mode & 0o077)
      throw new AppError(
        "NOT_CONFIGURED",
        "Configuration permissions must be 0600.",
        "Restrict config.json to the current user.",
      );
    return ConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
export async function initializeConfig(directory: string): Promise<Config> {
  const existing = await loadConfig(directory);
  if (existing) return existing;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const config: Config = {
    version: 1,
    owner_id: randomUUID(),
    account_id: randomUUID(),
    credential_ref: randomUUID(),
    ref_key: randomBytes(32).toString("base64"),
    apple_account: "",
    imap_username: "",
    caldav_username: "",
    sender_address: "",
    caldav_base_url: "https://caldav.icloud.com/",
    imap_host: "imap.mail.me.com",
    imap_port: 993,
    default_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    writable_calendar_ids: [],
  };
  try {
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify(config, null, 2),
      { mode: 0o600, flag: "wx" },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return (await loadConfig(directory))!;
  }
  return config;
}
export async function saveConfig(directory: string, config: Config) {
  const { rename } = await import("node:fs/promises");
  const temp = join(directory, `config.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(ConfigSchema.parse(config), null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, join(directory, "config.json"));
}
