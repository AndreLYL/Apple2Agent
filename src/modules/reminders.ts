import { z } from "zod";
import { authorize, type AccessContext } from "../core/context.js";
import type { Config } from "../core/config.js";
import type { NativeBridge } from "../core/native.js";
import { References, hash } from "../core/references.js";
import { HubState } from "../core/hub-state.js";
import { AppError } from "../core/errors.js";
import type { Module, ToolRegistry } from "./types.js";
const id = z.string().min(1).max(16384),
  request_id = z.uuid(),
  text = z.string().max(16000),
  date = z
    .string()
    .regex(/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d))?$/);
const fields = {
  title: z.string().min(1).max(1000).optional(),
  notes: text.optional(),
  due: date.optional(),
  priority: z.number().int().min(0).max(9).optional(),
  repeat: z.string().max(2000).optional(),
  clear_due: z.boolean().optional(),
  clear_repeat: z.boolean().optional(),
  alerts_before: z.array(z.number().int().min(0).max(86400)).max(10).optional(),
  alerts_at: z.array(date).max(10).optional(),
};
export class RemindersModule implements Module {
  domain = "reminders" as const;
  tools: ToolRegistry = {};
  constructor(
    private config: Config,
    private native: NativeBridge,
    private refs: References,
    private state: HubState,
  ) {
    const add = (
      name: string,
      schema: z.ZodType,
      operation: string,
      cap: "reminders:read" | "reminders:write" | "reminders:delete",
    ) =>
      (this.tools[name] = {
        schema,
        description: `${operation} in authorized native Reminders. IDs are exact references. Writes require a stable request_id and revision. Date-only stays a date; completion is a target state. Native revisions are best-effort, not atomic CAS.`,
        capability: cap,
        destructive: cap === "reminders:delete",
        run: (ctx, a) => this.run(ctx, operation, a, cap),
      });
    add(
      "reminders_list_lists",
      z.object({}).strict(),
      "reminder_lists",
      "reminders:read",
    );
    add(
      "reminders_list_reminders",
      z
        .object({
          list_id: id,
          query: text.optional(),
          completed: z.enum(["no", "only", "all"]).default("no"),
          completed_since: date.optional(),
          completed_before: date.optional(),
          due_since: date.optional(),
          due_before: date.optional(),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .strict(),
      "reminders_list",
      "reminders:read",
    );
    add(
      "reminders_get_reminder",
      z.object({ id }).strict(),
      "reminder_get",
      "reminders:read",
    );
    add(
      "reminders_create_reminder",
      z
        .object({
          ...fields,
          title: fields.title.unwrap(),
          list_id: id,
          request_id,
        })
        .strict(),
      "reminder_create",
      "reminders:write",
    );
    add(
      "reminders_update_reminder",
      z.object({ ...fields, id, expected_revision: id, request_id }).strict(),
      "reminder_update",
      "reminders:write",
    );
    add(
      "reminders_complete_reminder",
      z
        .object({
          id,
          completed: z.boolean(),
          expected_revision: id,
          request_id,
        })
        .strict(),
      "reminder_complete",
      "reminders:write",
    );
    add(
      "reminders_move_reminder",
      z.object({ id, list_id: id, expected_revision: id, request_id }).strict(),
      "reminder_move",
      "reminders:write",
    );
    add(
      "reminders_delete_reminder",
      z.object({ id, expected_revision: id, request_id }).strict(),
      "reminder_delete",
      "reminders:delete",
    );
    add(
      "reminders_create_list",
      z
        .object({ name: z.string().min(1).max(250), source_id: id, request_id })
        .strict(),
      "reminder_list_create",
      "reminders:write",
    );
    add(
      "reminders_update_list",
      z
        .object({
          list_id: id,
          name: z.string().min(1).max(250),
          expected_revision: id,
          request_id,
        })
        .strict(),
      "reminder_list_update",
      "reminders:write",
    );
    add(
      "reminders_delete_list",
      z
        .object({
          list_id: id,
          name: z.string().min(1).max(250),
          preview_token: id.optional(),
          request_id,
        })
        .strict(),
      "reminder_list_delete",
      "reminders:delete",
    );
  }
  private grants(ctx: AccessContext) {
    return {
      lists: [
        ...(ctx.grants?.reminder_lists ?? []),
        ...(this.state.get<string[]>(
          `created:${this.config.owner_id}:${this.config.account_id}:reminder_lists`,
        ) ?? []),
      ].filter((id) => !ctx.grants?.denied_reminder_lists?.includes(id)),
      sources: ctx.grants?.reminder_sources ?? [],
    };
  }
  private ref(row: any, kind = "reminder") {
    const list = row.list_id,
      source = row.source_id;
    if (row.id)
      row.id = this.refs.encode(kind, {
        id: row.id,
        source: row.source_id,
        list,
      });
    if (row.list_id)
      row.list_id = this.refs.encode("reminder-list", {
        id: row.list_id,
        source: row.source_id,
        list,
      });
    if (source)
      row.source_id = this.refs.encode("reminder-source", { id: source });
    return row;
  }
  async status(ctx: AccessContext) {
    try {
      const r = await this.run(ctx, "reminder_lists", {}, "reminders:read");
      return { status: "ready", ...r };
    } catch (e) {
      if (e instanceof AppError)
        return { status: "blocked", error: e.toJSON() };
      throw e;
    }
  }
  private async run(
    ctx: AccessContext,
    op: string,
    input: any,
    cap: "reminders:read" | "reminders:write" | "reminders:delete",
  ) {
    authorize(ctx, this.config, cap);
    if (
      (input.alerts_before?.length ?? 0) + (input.alerts_at?.length ?? 0) >
      10
    )
      throw new AppError(
        "INVALID_INPUT",
        "At most ten reminder alarms are supported.",
      );
    if (input.alerts_at?.some((t: string) => t.length === 10))
      throw new AppError(
        "INVALID_INPUT",
        "Absolute reminder alarms require an explicit offset time.",
      );
    if (
      op === "reminder_create" &&
      input.alerts_before?.length &&
      (!input.due || input.due.length === 10)
    )
      throw new AppError(
        "INVALID_INPUT",
        "Relative alarms require a timed due; use alerts_at for independent absolute reminders.",
      );
    const args = { ...input, grants: this.grants(ctx) };
    if (args.id) {
      const r = this.refs.decode<{ id: string; list: string }>(
        "reminder",
        args.id,
      );
      if (!args.grants.lists.includes(r.list))
        throw new AppError(
          "PERMISSION_DENIED",
          "Reminder list grant has been revoked.",
        );
      args.id = r.id;
    }
    if (args.list_id)
      args.list_id = this.refs.decode<{ id: string }>(
        "reminder-list",
        args.list_id,
      ).id;
    if (args.source_id)
      args.source_id = this.refs.decode<{ id: string }>(
        "reminder-source",
        args.source_id,
      ).id;
    if (args.list_id && !args.grants.lists.includes(args.list_id))
      throw new AppError(
        "PERMISSION_DENIED",
        "Reminder list is outside grant.",
      );
    if (args.source_id && !args.grants.sources.includes(args.source_id))
      throw new AppError(
        "PERMISSION_DENIED",
        "Reminder source is outside grant.",
      );
    if (args.alerts_before) args.alerts_before = args.alerts_before.join(",");
    if (args.alerts_at) args.alerts_at = args.alerts_at.join(",");
    const call = (operation = op, a = args) =>
      this.native.call<any>(ctx, "reminders", operation, a);
    const present = (out: any) => {
      if (Array.isArray(out))
        return {
          lists: out.map((r) => this.ref(r, "reminder-list")),
          verification_scope: "local",
        };
      if (out.lists)
        out.lists = out.lists.map((r: any) => this.ref(r, "reminder-list"));
      if (out.reminders)
        out.reminders = out.reminders.map((r: any) => this.ref(r));
      if (out.sources)
        out.sources = out.sources.map((s: any) => ({
          ...s,
          id: this.refs.encode("reminder-source", { id: s.id }),
        }));
      return out;
    };
    if (cap === "reminders:read") {
      const out = await call();
      return present(op === "reminder_get" ? this.ref(out) : out);
    }
    return this.state.locked(ctx, "reminders", async () => {
      if (op === "reminder_list_delete" && !args.preview_token) {
        const preview = await call(op, { ...args, preview: true });
        return {
          preview,
          ...preview,
          preview_token: this.refs.encode("reminder-list-preview", {
            id: args.list_id,
            hash: preview.snapshot,
            expires: Date.now() + 900000,
          }),
          executed: false,
        };
      }
      if (op === "reminder_list_delete") {
        const p = this.refs.decode<any>(
          "reminder-list-preview",
          args.preview_token,
        );
        if (
          p.id !== args.list_id ||
          (!this.state.hasWrite(ctx, op, args.request_id) &&
            p.expires < Date.now())
        )
          throw new AppError("STALE_REVISION", "List preview expired.");
        args.expected_snapshot = p.hash;
        args.delete_reminders = true;
      }
      let result: any;
      const out = await this.state.write(ctx, op, args.request_id, input, {
        prepare: async () => {
          await call("preflight", { ...args, target_operation: op });
        },
        write: async () => {
          result = await call();
          if (op === "reminder_list_create") {
            const ids =
              this.state.get<string[]>(
                `created:${this.config.owner_id}:${this.config.account_id}:reminder_lists`,
              ) ?? [];
            this.state.put(
              `created:${this.config.owner_id}:${this.config.account_id}:reminder_lists`,
              [...new Set([...ids, result.id])],
            );
          }
          return {
            id: result.id ?? result.deleted ?? args.id ?? args.list_id,
            revision: result.revision,
            completed: result.completed,
            deleted: result.deleted,
            source_id: result.source_id,
            list_id: result.list_id ?? args.list_id,
          };
        },
        verify: async (receipt) => {
          if (!receipt) return undefined; // No trustworthy native id: never create/complete another instance.
          try {
            if (op.endsWith("delete")) {
              await call(
                op === "reminder_list_delete" ? "list_get" : "reminder_get",
                { ...args, id: receipt.id, list_id: receipt.id },
              );
              return undefined;
            }
            const row = await call(
              op.includes("list_") ? "list_get" : "reminder_get",
              { ...args, id: receipt.id, list_id: receipt.id },
            );
            if (receipt.revision && row.revision !== receipt.revision)
              return undefined;
            return receipt;
          } catch (e) {
            if (
              op.endsWith("delete") &&
              e instanceof AppError &&
              ["NOT_FOUND", "STALE_REFERENCE"].includes(e.code)
            )
              return receipt;
            throw e;
          }
        },
      });
      return {
        ...out,
        resource: out.resource?.id
          ? this.ref(
              { ...out.resource },
              op.includes("list_") ? "reminder-list" : "reminder",
            )
          : out.resource,
        native_concurrency: "best_effort",
        phone_sync_verified: false,
      };
    });
  }
}
