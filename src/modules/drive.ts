import { toolDescription } from "../core/tool-descriptions.js";
import { z } from "zod";
import { resolve, extname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  authorize,
  requireGrant,
  type AccessContext,
} from "../core/context.js";
import type { Config } from "../core/config.js";
import type { NativeBridge } from "../core/native.js";
import { References, hash } from "../core/references.js";
import { HubState } from "../core/hub-state.js";
import { AppError } from "../core/errors.js";
import type { Module, ToolRegistry } from "./types.js";
const id = z.string().min(1).max(16384),
  path = z.string().max(2048),
  request_id = z.uuid();
const scope = { root_id: id, path: path.default("") };
const textExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
  ".ics",
  ".vcf",
  ".ts",
  ".js",
  ".py",
  ".html",
  ".htm",
]);
export class DriveModule implements Module {
  domain = "drive" as const;
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
      cap: "drive:read" | "drive:write" | "drive:delete",
    ) =>
      (this.tools[name] = {
        schema,
        capability: cap,
        description: toolDescription(name),
        run: (ctx, a) => this.run(ctx, op, a, cap),
      });
    add("drive_list_roots", z.object({}).strict(), "roots", "drive:read");
    add(
      "drive_list_folder",
      z
        .object({
          ...scope,
          limit: z.number().int().min(1).max(1000).default(200),
        })
        .strict(),
      "list",
      "drive:read",
    );
    add("drive_get_info", z.object(scope).strict(), "info", "drive:read");
    add(
      "drive_read_file",
      z.object({ ...scope, download: z.boolean().default(false) }).strict(),
      "text",
      "drive:read",
    );
    add(
      "drive_get_file",
      z.object({ ...scope, download: z.boolean().default(false) }).strict(),
      "read",
      "drive:read",
    );
    for (const [name, op] of [
      ["drive_search_files", "names"],
      ["drive_search_content", "content"],
    ] as const)
      add(
        name,
        z
          .object({
            ...scope,
            query: z.string().min(1).max(500),
            limit: z.number().int().min(1).max(100).default(30),
          })
          .strict(),
        op,
        "drive:read",
      );
    add(
      "drive_write_file",
      z
        .object({
          ...scope,
          text: z.string().max(4194304),
          overwrite: z.boolean().default(false),
          expected_revision: id.optional(),
          request_id,
        })
        .strict(),
      "write",
      "drive:write",
    );
    add(
      "drive_create_folder",
      z.object({ ...scope, request_id }).strict(),
      "mkdir",
      "drive:write",
    );
    add(
      "drive_move_item",
      z
        .object({ ...scope, target: path, expected_revision: id, request_id })
        .strict(),
      "move",
      "drive:write",
    );
    add(
      "drive_trash_item",
      z
        .object({
          ...scope,
          expected_revision: id,
          preview_token: id.optional(),
          request_id,
        })
        .strict(),
      "trash",
      "drive:delete",
    );
  }
  async status(ctx: AccessContext) {
    authorize(ctx, this.config, "drive:read");
    return {
      status: ctx.grants?.drive_roots?.length ? "configured" : "not_configured",
      root_count: ctx.grants?.drive_roots?.length ?? 0,
    };
  }
  private root(ctx: AccessContext, token: string) {
    const root = this.refs.decode<{ path: string }>("drive-root", token).path;
    requireGrant(ctx, "drive_roots", root);
    return root;
  }
  private async extract(ctx: AccessContext, a: any) {
    const r = await this.native.call<any>(
      ctx,
      "drive",
      extname(a.path).toLowerCase() === ".pdf" ? "pdf" : "read",
      a,
    );
    if (!r.base64 && !r.text) return r;
    if (r.text) return r;
    const b = Buffer.from(r.base64, "base64"),
      ext = extname(a.path).toLowerCase();
    let text: string;
    if (textExtensions.has(ext)) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(b);
      } catch {
        throw new AppError(
          "FORMAT_UNSUPPORTED",
          "The text file is not valid UTF-8.",
        );
      }
      if (ext === ".html" || ext === ".htm") {
        const { convert } = await import("html-to-text");
        text = convert(text, {
          selectors: [
            { selector: "script", format: "skip" },
            { selector: "style", format: "skip" },
          ],
        });
      }
    } else if ([".doc", ".docx", ".rtf", ".odt"].includes(ext)) {
      text = await new Promise<string>((resolve, reject) => {
        const p = spawn(
          "/usr/bin/textutil",
          ["-convert", "txt", "-stdin", "-stdout", "-format", ext.slice(1)],
          { stdio: ["pipe", "pipe", "ignore"], signal: ctx.signal },
        );
        let n = 0,
          s = "";
        p.stdout.on("data", (b: Buffer) => {
          n += b.length;
          if (n > 4 * 1024 * 1024) {
            p.kill();
            reject(
              new AppError(
                "CONTENT_TOO_LARGE",
                "Extracted text exceeds limit.",
              ),
            );
          } else s += b.toString();
        });
        p.on("error", () =>
          reject(
            new AppError("FORMAT_UNSUPPORTED", "Text extraction unavailable."),
          ),
        );
        p.on("close", (c) =>
          c === 0
            ? resolve(s)
            : reject(
                new AppError(
                  "FORMAT_UNSUPPORTED",
                  "This document cannot be safely extracted.",
                ),
              ),
        );
        p.stdin.on("error", () => {});
        p.stdin.end(b);
      });
    } else
      throw new AppError(
        "FORMAT_UNSUPPORTED",
        "Use get_file for this file type.",
      );
    const { base64, ...meta } = r;
    return {
      ...meta,
      text: text.slice(0, 262144),
      truncated: text.length > 262144,
      extracted_at: new Date().toISOString(),
      cache: false,
    };
  }
  private async snapshot(
    ctx: AccessContext,
    root: string,
    path: string,
    current: any,
  ) {
    const entries: any[] = [{ path, revision: current.revision }],
      queue = current.directory ? [path] : [];
    while (queue.length) {
      const folder = queue.shift()!;
      const r = await this.native.call<any>(ctx, "drive", "list", {
        root,
        path: folder,
        limit: 1000,
      });
      if (!r.complete)
        throw new AppError(
          "INCOMPLETE_DATA",
          "Directory preview exceeded the bound.",
        );
      for (const item of r.items) {
        const p = [folder, item.name].filter(Boolean).join("/");
        entries.push({ path: p, revision: item.revision });
        if (entries.length > 1000)
          throw new AppError(
            "INCOMPLETE_DATA",
            "Directory preview is limited to 1000 entries.",
          );
        if (item.directory) queue.push(p);
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { count: entries.length, digest: hash(entries) };
  }
  private async run(
    ctx: AccessContext,
    op: string,
    input: any,
    cap: "drive:read" | "drive:write" | "drive:delete",
  ): Promise<any> {
    authorize(ctx, this.config, cap);
    if (op === "roots")
      return {
        roots: (ctx.grants?.drive_roots ?? []).map((p) => ({
          root_id: this.refs.encode("drive-root", { path: p }),
          name: p.split("/").at(-1),
        })),
      };
    const root = this.root(ctx, input.root_id);
    const a = { ...input, root };
    const call = (operation = op, args = a) =>
      this.native.call<any>(ctx, "drive", operation, args);
    if (op === "text") return this.extract(ctx, a);
    if (op === "names" || op === "content") {
      let scanned = 0,
        scannedBytes = 0,
        skipped = 0,
        complete = true;
      const matches: any[] = [],
        queue = [input.path];
      while (queue.length && scanned < 500 && matches.length < input.limit) {
        ctx.signal.throwIfAborted();
        const folder = queue.shift()!;
        const out = await call("list", { ...a, path: folder, limit: 1000 });
        if (!out.complete) complete = false;
        for (const item of out.items) {
          scanned++;
          const p = [folder, item.name].filter(Boolean).join("/");
          if (scanned > 500) {
            complete = false;
            break;
          }
          if (item.directory) {
            queue.push(p);
            if (
              op === "names" &&
              item.name.toLowerCase().includes(input.query.toLowerCase())
            )
              matches.push({ ...item, path: p });
            continue;
          }
          if (op === "names") {
            if (item.name.toLowerCase().includes(input.query.toLowerCase()))
              matches.push({ ...item, path: p });
          } else {
            try {
              scannedBytes += item.size ?? 0;
              if (scannedBytes > 32 * 1024 * 1024) {
                complete = false;
                queue.length = 0;
                break;
              }
              const r = await this.extract(ctx, {
                ...a,
                path: p,
                download: false,
              });
              if (!r.text) {
                skipped++;
                continue;
              }
              const pos = r.text
                .toLowerCase()
                .indexOf(input.query.toLowerCase());
              if (pos >= 0)
                matches.push({
                  path: p,
                  revision: r.revision,
                  snippet: r.text.slice(
                    Math.max(0, pos - 80),
                    pos + input.query.length + 160,
                  ),
                });
              if (r.truncated) skipped++;
            } catch {
              skipped++;
            }
          }
          if (matches.length >= input.limit) {
            complete = false;
            break;
          }
        }
      }
      if (queue.length || skipped) complete = false;
      return {
        matches,
        complete,
        scanned,
        skipped,
        scanned_bytes: scannedBytes,
        scope: { root_id: input.root_id, path: input.path },
        refreshed_at: new Date().toISOString(),
      };
    }
    if (cap === "drive:read") return call();
    return this.state.locked(ctx, "drive", async () => {
      const current = await call("info").catch((e) => {
        if (e instanceof AppError && e.code === "NOT_FOUND") return undefined;
        throw e;
      });
      if (op === "trash" && !input.preview_token) {
        if (!current)
          throw new AppError("NOT_FOUND", "Item is no longer available.");
        const snapshot = await this.snapshot(ctx, root, input.path, current);
        const preview = {
          revision: current.revision,
          path: input.path,
          affected_items: snapshot.count,
          snapshot_hash: snapshot.digest,
        };
        return {
          preview,
          preview_token: this.refs.encode("drive-preview", {
            ...preview,
            root_id: input.root_id,
            expires: Date.now() + 900000,
          }),
          executed: false,
        };
      }
      if (op === "trash") {
        const p = this.refs.decode<any>("drive-preview", input.preview_token);
        if (
          p.root_id !== input.root_id ||
          p.path !== input.path ||
          p.revision !== input.expected_revision ||
          (!this.state.hasWrite(ctx, `drive:${op}`, input.request_id) &&
            p.expires < Date.now())
        )
          throw new AppError(
            "STALE_REVISION",
            "Drive preview expired or changed.",
          );
      }
      return this.state.write(ctx, `drive:${op}`, input.request_id, input, {
        prepare: async () => {
          if (
            ["move", "trash"].includes(op) ||
            (op === "write" && input.overwrite)
          ) {
            if (current?.sync_state !== "local")
              throw new AppError(
                "FILE_NOT_LOCAL",
                "Download and verify this item before changing it.",
              );
          }
          if (op === "trash") {
            const preview = this.refs.decode<any>(
              "drive-preview",
              input.preview_token,
            );
            if (!current)
              throw new AppError("NOT_FOUND", "Item is no longer available.");
            const now = await this.snapshot(ctx, root, input.path, current);
            if (preview.snapshot_hash !== now.digest)
              throw new AppError(
                "STALE_REVISION",
                "Directory contents changed after the trash preview.",
              );
          }
          if (
            op === "write" &&
            Buffer.byteLength(input.text, "utf8") > 4 * 1024 * 1024
          )
            throw new AppError("CONTENT_TOO_LARGE", "Text exceeds 4 MiB.");
          if (
            op === "write" &&
            !textExtensions.has(extname(input.path).toLowerCase())
          )
            throw new AppError(
              "FORMAT_UNSUPPORTED",
              "Only plain text files can be written.",
            );
          if (op === "write" && input.overwrite) {
            if (
              !current ||
              current.revision !== input.expected_revision ||
              current.directory
            )
              throw new AppError(
                "STALE_REVISION",
                "Read the current plain-text file before replacing it.",
              );
            const old = await call("read");
            const backup = join(this.directory, "backups", "drive");
            await mkdir(backup, { recursive: true, mode: 0o700 });
            await writeFile(
              join(
                backup,
                `${hash([input.root_id, input.path, input.request_id])}.bin`,
              ),
              Buffer.from(old.base64, "base64"),
              { mode: 0o600, flag: "wx" },
            ).catch((e) => {
              if (e.code !== "EEXIST") throw e;
            });
          }
        },
        write: async () => {
          const r = await call();
          return {
            path: op === "move" ? input.target : input.path,
            revision: r.revision,
            trashed: r.trashed,
            trash_name: r.trash_name,
          };
        },
        verify: async (receipt) => {
          if (!receipt) return undefined;
          if (receipt.trashed) {
            try {
              await call("info");
              return undefined;
            } catch (e) {
              if (e instanceof AppError && e.code === "NOT_FOUND")
                return receipt;
              throw e;
            }
          }
          const r = await call("info", { ...a, path: receipt.path });
          return r.revision === receipt.revision ? receipt : undefined;
        },
      });
    });
  }
}
