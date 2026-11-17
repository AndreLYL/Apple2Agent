import { toolDescription } from "../core/tool-descriptions.js";
import { z } from "zod";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { authorize, type AccessContext } from "../core/context.js";
import type { Config } from "../core/config.js";
import type { NativeBridge } from "../core/native.js";
import { References, hash } from "../core/references.js";
import { HubState } from "../core/hub-state.js";
import { AppError } from "../core/errors.js";
import type { Module, ToolRegistry } from "./types.js";
const id = z.string().min(1).max(16384),
  request_id = z.uuid(),
  title = z.string().min(1).max(1000),
  text = z.string().max(262144);
export class NotesModule implements Module {
  domain = "notes" as const;
  tools: ToolRegistry = {};
  constructor(
    private config: Config,
    private native: NativeBridge,
    private refs: References,
    private state: HubState,
    private directory: string,
  ) {
    const add = (
      name: string,
      schema: z.ZodType,
      op: string,
      cap: "notes:read" | "notes:write" | "notes:delete",
    ) =>
      (this.tools[name] = {
        schema,
        capability: cap,
        description: toolDescription(name),
        run: (ctx, a) => this.run(ctx, op, a, cap),
      });
    add("notes_list_folders", z.object({}).strict(), "folders", "notes:read");
    add(
      "notes_list_notes",
      z
        .object({
          folder_id: id,
          query: z.string().max(500).optional(),
          search_body: z.boolean().default(false),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .strict(),
      "list",
      "notes:read",
    );
    add("notes_read_note", z.object({ id }).strict(), "read", "notes:read");
    add(
      "notes_create_note",
      z.object({ folder_id: id, title, text, request_id }).strict(),
      "create",
      "notes:write",
    );
    add(
      "notes_create_folder",
      z.object({ account_id: id, name: title, request_id }).strict(),
      "folder_create",
      "notes:write",
    );
    for (const [name, op, cap] of [
      ["notes_append_to_note", "append", "notes:write"],
      ["notes_update_note", "rewrite", "notes:write"],
      ["notes_move_note", "move", "notes:write"],
      ["notes_delete_note", "delete", "notes:delete"],
    ] as const)
      add(
        name,
        z
          .object({
            id,
            title,
            content_hash: id,
            request_id,
            ...(op === "append" || op === "rewrite" ? { text } : {}),
            ...(op === "move" ? { folder_id: id } : {}),
            ...(op === "rewrite" ? { preview_token: id.optional() } : {}),
          })
          .strict(),
        op,
        cap,
      );
  }
  private grants(ctx: AccessContext) {
    return {
      accounts: ctx.grants?.notes_accounts ?? [],
      folders: [
        ...(ctx.grants?.notes_folders ?? []),
        ...(this.state.get<string[]>(
          `created:${this.config.owner_id}:${this.config.account_id}:notes_folders`,
        ) ?? []),
      ].filter((id) => !ctx.grants?.denied_notes_folders?.includes(id)),
    };
  }
  private present(r: any) {
    const { html, native_hash, ...row } = r;
    if (r.id)
      row.id = this.refs.encode("note", { id: r.id, folder: r.folder_id });
    if (r.folder_id)
      row.folder_id = this.refs.encode("notes-folder", { id: r.folder_id });
    if (r.text !== undefined)
      row.content_hash = hash([r.id, r.title, r.text, r.modified]);
    return row;
  }
  async status(ctx: AccessContext) {
    authorize(ctx, this.config, "notes:read");
    return {
      status: this.grants(ctx).folders.length ? "configured" : "not_configured",
      folder_count: this.grants(ctx).folders.length,
    };
  }
  private async run(
    ctx: AccessContext,
    op: string,
    input: any,
    cap: "notes:read" | "notes:write" | "notes:delete",
  ): Promise<any> {
    authorize(ctx, this.config, cap);
    const a = { ...input, grants: this.grants(ctx) };
    if (a.id) {
      const r = this.refs.decode<any>("note", a.id);
      if (!a.grants.folders.includes(r.folder))
        throw new AppError(
          "PERMISSION_DENIED",
          "Note folder grant has been revoked.",
        );
      a.id = r.id;
    }
    if (a.folder_id)
      a.folder_id = this.refs.decode<any>("notes-folder", a.folder_id).id;
    if (a.account_id)
      a.account_id = this.refs.decode<any>("notes-account", a.account_id).id;
    if (a.folder_id && !a.grants.folders.includes(a.folder_id))
      throw new AppError(
        "PERMISSION_DENIED",
        "Target folder is outside grant.",
      );
    if (a.account_id && !a.grants.accounts.includes(a.account_id))
      throw new AppError(
        "PERMISSION_DENIED",
        "Notes account is outside grant.",
      );
    const call = (operation = op, args = a) =>
      this.native.call<any>(ctx, "automation", `notes_${operation}`, args);
    if (cap === "notes:read") {
      const r = await call();
      if (r.notes) r.notes = r.notes.map((n: any) => this.present(n));
      if (r.accounts)
        r.accounts = r.accounts.map((acc: any) => ({
          ...acc,
          id: this.refs.encode("notes-account", { id: acc.id }),
        }));
      if (r.folders)
        r.folders = r.folders.map((f: any) => ({
          ...f,
          id: this.refs.encode("notes-folder", { id: f.id }),
        }));
      return r.id ? this.present(r) : r;
    }
    return this.state.locked(ctx, "notes", async () => {
      let before: any;
      let after: any;
      let backup_id: string | undefined;
      const refresh = async () => {
        if (!a.id) return;
        before = await call("read", { ...a, include_html: true });
        if (
          before.truncated ||
          before.locked ||
          this.present(before).content_hash !== input.content_hash ||
          before.title !== input.title
        )
          throw new AppError(
            "STALE_REVISION",
            "Read the full current note and title before changing it.",
          );
        a.expected_native_hash = before.native_hash;
      };
      if (op === "rewrite" && !input.preview_token) {
        await refresh();
        return {
          executed: false,
          preview: {
            id: input.id,
            title: input.title,
            text: input.text,
            format: "plain_text_rewrite",
            loses_formatting: true,
          },
          preview_token: this.refs.encode("notes-rewrite", {
            digest: hash({ ...input, preview_token: undefined }),
            expires: Date.now() + 900000,
          }),
        };
      }
      if (op === "rewrite") {
        const p = this.refs.decode<any>("notes-rewrite", input.preview_token);
        if (
          (!this.state.hasWrite(ctx, `notes:${op}`, input.request_id) &&
            p.expires < Date.now()) ||
          p.digest !== hash({ ...input, preview_token: undefined })
        )
          throw new AppError(
            "STALE_REVISION",
            "Rewrite preview expired or changed.",
          );
      }
      const result = await this.state.write(
        ctx,
        `notes:${op}`,
        input.request_id,
        input,
        {
          prepare: async () => {
            await refresh();
            if (before) {
              if (
                before.attachments ||
                before.has_table ||
                before.recently_deleted
              )
                throw new AppError(
                  "FORMAT_UNSUPPORTED",
                  "This note cannot be safely modified.",
                );
              const dir = join(this.directory, "backups", "notes");
              await mkdir(dir, { recursive: true, mode: 0o700 });
              backup_id = hash([
                ctx.owner_id,
                ctx.account_id,
                a.id,
                input.request_id,
              ]);
              await writeFile(
                join(dir, `${backup_id}.json`),
                JSON.stringify({
                  id: a.id,
                  title: before.title,
                  html: before.html,
                  content_hash: input.content_hash,
                  created_at: new Date().toISOString(),
                }),
                { mode: 0o600, flag: "wx" },
              ).catch((e) => {
                if (e.code !== "EEXIST") throw e;
              });
            }
          },
          write: async () => {
            after = await call();
            if (op === "folder_create") {
              const ids =
                this.state.get<string[]>(
                  `created:${this.config.owner_id}:${this.config.account_id}:notes_folders`,
                ) ?? [];
              this.state.put(
                `created:${this.config.owner_id}:${this.config.account_id}:notes_folders`,
                [...new Set([...ids, after.id])],
              );
            }
            return {
              id: after.id ?? a.id,
              folder_id: after.folder_id ?? before?.folder_id,
              content_hash:
                after.text !== undefined
                  ? this.present(after).content_hash
                  : undefined,
              deleted: after.deleted,
              backup_id,
            };
          },
          verify: async (receipt) => {
            if (!receipt) return undefined;
            if (receipt.deleted) {
              try {
                const r = await call("read");
                return r.recently_deleted ? receipt : undefined;
              } catch (e) {
                if (e instanceof AppError && e.code === "STALE_REFERENCE")
                  return receipt;
                throw e;
              }
            }
            if (op === "folder_create") {
              const r = await call("folders", {
                ...a,
                grants: this.grants(ctx),
              });
              return r.folders.some((f: any) => f.id === receipt.id)
                ? receipt
                : undefined;
            }
            const r = await call("read", {
              ...a,
              id: receipt.id,
              grants: this.grants(ctx),
            });
            return this.present(r).content_hash === receipt.content_hash
              ? receipt
              : undefined;
          },
        },
      );
      return {
        ...result,
        resource: result.resource
          ? {
              ...result.resource,
              folder_id: result.resource.folder_id
                ? this.refs.encode("notes-folder", {
                    id: result.resource.folder_id,
                  })
                : undefined,
              id: this.refs.encode(
                op === "folder_create" ? "notes-folder" : "note",
                { id: result.resource.id, folder: result.resource.folder_id },
              ),
            }
          : undefined,
        native_concurrency: "best_effort",
        phone_sync_verified: false,
      };
    });
  }
}
