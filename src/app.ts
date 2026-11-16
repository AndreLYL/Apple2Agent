import { VERSION } from "./core/version.js";
import { join } from "node:path";
import { lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "./core/config.js";
import {
  allCapabilities,
  profileCapabilities,
  type Profile,
  type AccessContext,
} from "./core/context.js";
import { KeychainCredentialStore } from "./core/credentials.js";
import { SQLiteOperationStore } from "./core/operations.js";
import { References } from "./core/references.js";
import { CalDAVAdapter } from "./adapters/caldav.js";
import { IMAPAdapter } from "./adapters/imap.js";
import { AdvancedCalendarService } from "./services/calendar-advanced.js";
import { HubState } from "./core/hub-state.js";
import { ApprovalStore } from "./core/approvals.js";
import { hash } from "./core/references.js";
import { MailService } from "./services/mail.js";
import { AppError, safeError } from "./core/errors.js";
import { z } from "zod";
const awaitlessSchema = () =>
  z.object({ action_id: z.string().min(1).max(16384) }).strict();
import debug from "debug";
import { ProcessNativeBridge } from "./core/native.js";
import { RemindersModule } from "./modules/reminders.js";
import { NotesModule } from "./modules/notes.js";
import { DriveModule } from "./modules/drive.js";
import { ContactsModule } from "./modules/contacts.js";
import { MessagesModule } from "./modules/messages.js";
import { MailModule } from "./modules/mail.js";
import { MailHub, HubApprovals } from "./modules/mail-hub.js";
import { CardDAVAdapter } from "./adapters/carddav.js";
import { AdvancedIMAPAdapter } from "./adapters/imap-advanced.js";
import { SMTPAdapter } from "./adapters/smtp.js";
import type { Module, ToolRegistry } from "./modules/types.js";
export interface Application {
  calendar: AdvancedCalendarService;
  mail: MailService;
  context(signal: AbortSignal): AccessContext;
  status(ctx: AccessContext): Promise<Record<string, unknown>>;
  close(): void;
  state: HubState;
  approvals: ApprovalStore;
  modules: Module[];
  tools: ToolRegistry;
  enabledModules: string[];
}
export function createApplication(
  config: Config,
  directory: string,
  options: { profile?: Profile; actor_id?: string } = {},
): Application {
  const signature = () => {
    try {
      const s = lstatSync(join(directory, "config.json"), { bigint: true });
      return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.size}:${s.mode}`;
    } catch {
      return "missing";
    }
  };
  const initialSignature = signature();
  const assertCurrent = () => {
    if (signature() !== initialSignature)
      throw new AppError(
        "CONFIGURATION_CHANGED",
        "Local configuration changed; this process must restart before using resources.",
        "Reconnect this MCP server to load current resource grants.",
      );
  };
  debug.disable(); // Never emit raw DAV headers or bodies, even with inherited DEBUG=*.
  const credentials = new KeychainCredentialStore(
    fileURLToPath(new URL("../bin/keychain-helper", import.meta.url)),
  );
  const operations = new SQLiteOperationStore(
    join(directory, "operations.sqlite"),
  );
  const refs = new References(config, config.ref_key);
  const calendarAdapter = new CalDAVAdapter(config, credentials);
  const mailAdapter = new AdvancedIMAPAdapter(config, credentials);
  const state = new HubState(join(directory, "operations.sqlite"));
  const keyHash = hash([config.owner_id, "approval-encryption"]).slice(0, 32);
  const keyRef =
    config.hub?.approval_key_ref ??
    `${keyHash.slice(0, 8)}-${keyHash.slice(8, 12)}-4${keyHash.slice(13, 16)}-a${keyHash.slice(17, 20)}-${keyHash.slice(20)}`;
  const approvalKey = () => credentials.key(keyRef, AbortSignal.timeout(30000));
  const approvals = new HubApprovals(state, config, approvalKey);
  const calendar = new AdvancedCalendarService(
    config,
    calendarAdapter,
    refs,
    operations,
    state,
    directory,
  );
  const mail = new MailService(config, mailAdapter, refs, operations);
  const native = new ProcessNativeBridge();
  const modules: Module[] = [
    new RemindersModule(config, native, refs, state),
    new NotesModule(config, native, refs, state, directory),
    new DriveModule(config, native, refs, state, directory),
    new ContactsModule(
      config,
      new CardDAVAdapter(config, credentials),
      refs,
      state,
    ),
    new MessagesModule(config, native, refs, approvals),
    new MailHub(
      config,
      new MailModule(
        config,
        mailAdapter,
        new SMTPAdapter(config, credentials),
        native,
        refs,
        state,
        approvals,
      ),
      credentials,
      native,
      state,
      approvals,
      approvalKey,
    ),
  ];
  approvals.mailHub = modules.find((m) => m.domain === "mail") as MailHub;
  const enabledModules: string[] = config.hub?.enabled_modules ?? [
    "calendar",
    "mail",
  ];
  const tools = Object.assign(
    {},
    ...modules
      .filter((m) => enabledModules.includes(m.domain))
      .map((m) => m.tools),
  ) as ToolRegistry;
  tools.apple_action_status = {
    schema: awaitlessSchema(),
    capability: "mail:read",
    description: "Read the exact action status. This cannot approve an action.",
    run: async (ctx, a) => approvals.status(ctx, a.action_id),
  };
  tools.apple_action_discard = {
    readOnly: false,
    schema: awaitlessSchema(),
    capability: "mail:read",
    description: "Cancel an unreleased action. This never approves or sends.",
    run: async (ctx, a) => approvals.discard(ctx, a.action_id),
  };
  return {
    modules,
    tools,
    enabledModules,
    calendar,
    mail,
    state,
    approvals,
    context: (signal) => {
      assertCurrent();
      return {
        owner_id: config.owner_id,
        account_id: config.account_id,
        actor_id: options.actor_id ?? "local-owner",
        capabilities: profileCapabilities(
          options.profile ?? "legacy",
          config.hub?.capabilities
            ? allCapabilities.filter(
                (c) =>
                  config.hub!.capabilities!.includes(c) &&
                  enabledModules.includes(c.split(":")[0]!),
              )
            : allCapabilities.filter((c) =>
                enabledModules.includes(c.split(":")[0]!),
              ),
        ),
        grants: config.hub,
        signal,
        assert_current: assertCurrent,
      };
    },
    async status(ctx) {
      if (
        ctx.owner_id !== config.owner_id ||
        ctx.account_id !== config.account_id
      )
        throw new AppError("PERMISSION_DENIED", "Wrong account context.");
      const denied = () =>
        Promise.reject(
          new AppError(
            "PERMISSION_DENIED",
            "Read capability is not granted.",
            "Use a caller with read access.",
          ),
        );
      const [c, m] = await Promise.allSettled([
        ctx.capabilities.has("calendar:read")
          ? calendarAdapter.list(ctx)
          : denied(),
        ctx.capabilities.has("mail:read")
          ? mailAdapter.folders(ctx)
          : Promise.resolve(undefined),
      ]);
      const result = (r: PromiseSettledResult<unknown>, countName: string) =>
        r.status === "fulfilled"
          ? { status: "connected", [countName]: (r.value as unknown[]).length }
          : { status: "error", error: safeError(r.reason).toJSON() };
      return {
        version: VERSION,
        transport: "stdio",
        account: "primary",
        timezone: config.default_timezone,
        caldav: result(c, "calendar_count"),
        imap: ctx.capabilities.has("mail:read")
          ? result(m, "folder_count")
          : { status: "disabled" },
        current_time: new Date().toISOString(),
        profile: options.profile ?? "legacy",
        modules: modules.map((m) => ({
          module: m.domain,
          status: enabledModules.includes(m.domain) ? "enabled" : "disabled",
        })),
        trusted_approval: {
          local: "native_window",
          mobile: "local_review_required",
        },
        write_calendar_configured: !!config.default_calendar_id,
        calendar_write_scope: config.calendar_write_scope ?? "selected",
      };
    },
    close() {
      operations.close();
      state.close();
    },
  };
}
