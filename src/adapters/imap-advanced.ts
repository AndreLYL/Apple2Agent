import { IMAPAdapter, type MailRef } from "./imap.js";
import type { AccessContext } from "../core/context.js";
import { AppError } from "../core/errors.js";
import { hash } from "../core/references.js";
export class AdvancedIMAPAdapter extends IMAPAdapter {
  async changes(
    ctx: AccessContext,
    folder: string,
    validity: string,
    uids: number[],
  ) {
    if (!uids.length) return [];
    return this.mailbox(ctx, folder, validity, async (client) => {
      const rows = await client.fetchAll(
        uids.join(","),
        { flags: true },
        { uid: true },
      );
      return rows.map((m) => ({
        uid: m.uid,
        fingerprint: hash([
          m.uid,
          [...(m.flags ?? [])].sort(),
          m.modseq?.toString(),
        ]),
      }));
    });
  }
  async raw(ctx: AccessContext, ref: MailRef, max = 8 * 1024 * 1024) {
    return this.mailbox(ctx, ref.folder, ref.uidvalidity, async (client) => {
      const meta = await client.fetchOne(
        ref.uid,
        { size: true, flags: true, envelope: true },
        { uid: true },
      );
      if (!meta)
        throw new AppError("NOT_FOUND", "Message is no longer available.");
      if ((meta.size ?? Infinity) > max)
        throw new AppError(
          "CONTENT_TOO_LARGE",
          "Raw mail exceeds the 8 MiB parsing limit.",
        );
      const m = await client.fetchOne(
        ref.uid,
        { source: { maxLength: max } },
        { uid: true },
      );
      if (!m || !m.source || (meta.size ?? 0) > m.source.length)
        throw new AppError(
          "CONTENT_TOO_LARGE",
          "Incomplete MIME source cannot be processed.",
        );
      const flags = [...(meta.flags ?? [])].sort();
      return {
        source: m.source,
        flags,
        modseq: meta.modseq?.toString(),
        revision: hash([
          ref,
          flags,
          meta.modseq?.toString(),
          hash(m.source.toString("base64")),
        ]),
      };
    });
  }
  async appendRaw(
    ctx: AccessContext,
    folder: string,
    raw: Buffer,
    flags: string[],
  ) {
    return this.using(
      ctx,
      async (client) => {
        const r = await client.append(folder, raw, flags);
        if (!r)
          throw new AppError(
            "WRITE_FAILED",
            "Server did not accept the appended message.",
          );
        return {
          folder,
          uidvalidity: String(r.uidValidity ?? ""),
          uid: Number(r.uid ?? 0),
        };
      },
      true,
    );
  }
  async mark(
    ctx: AccessContext,
    ref: MailRef,
    change: { seen?: boolean; flagged?: boolean; answered?: boolean },
    expectedRevision?: string,
  ) {
    const current = await this.raw(ctx, ref);
    if (expectedRevision && current.revision !== expectedRevision)
      throw new AppError("STALE_REVISION", "Message flags or content changed.");
    return this.using(
      ctx,
      async (c) => {
        const lock = await c.getMailboxLock(ref.folder, { readOnly: false });
        try {
          if (this.validity(c) !== ref.uidvalidity)
            throw new AppError(
              "STALE_REFERENCE",
              "Mailbox UIDVALIDITY changed.",
            );
          const flags = new Set(current.flags);
          for (const [key, flag] of [
            ["seen", "\\Seen"],
            ["flagged", "\\Flagged"],
            ["answered", "\\Answered"],
          ] as const) {
            const val = change[key];
            if (val !== undefined) {
              if (val) flags.add(flag);
              else flags.delete(flag);
            }
          }
          const r = await c.messageFlagsSet(ref.uid, [...flags], {
            uid: true,
            ...(current.modseq
              ? { unchangedSince: BigInt(current.modseq) }
              : {}),
          });
          if (!r)
            throw new AppError(
              "STALE_REVISION",
              "Conditional flag update was rejected.",
            );
          return { ref, flags: change };
        } finally {
          lock.release();
        }
      },
      true,
    );
  }
  async move(
    ctx: AccessContext,
    ref: MailRef,
    target: string,
    expectedRevision?: string,
  ) {
    if (
      expectedRevision &&
      (await this.raw(ctx, ref)).revision !== expectedRevision
    )
      throw new AppError("STALE_REVISION", "Message changed before moving.");
    return this.using(
      ctx,
      async (c) => {
        const lock = await c.getMailboxLock(ref.folder, { readOnly: false });
        try {
          if (this.validity(c) !== ref.uidvalidity)
            throw new AppError(
              "STALE_REFERENCE",
              "Mailbox UIDVALIDITY changed.",
            );
          const r = await c.messageMove(ref.uid, target, { uid: true });
          if (!r) throw new AppError("WRITE_FAILED", "Move was not accepted.");
          const dest = r.uidMap?.get(ref.uid);
          return {
            folder: target,
            uidvalidity: String(r.uidValidity ?? ""),
            uid: dest ?? 0,
            source: ref,
          };
        } finally {
          lock.release();
        }
      },
      true,
    );
  }
  async folder(
    ctx: AccessContext,
    action: "create" | "rename" | "delete",
    path: string,
    target?: string,
  ) {
    return this.using(
      ctx,
      async (c) => {
        if (action === "create") await c.mailboxCreate(path);
        else if (action === "rename") await c.mailboxRename(path, target!);
        else {
          const status = await c.status(path, { messages: true });
          if (!status || status.messages)
            throw new AppError(
              "FOLDER_NOT_EMPTY",
              "Folder still contains messages; move them with a frozen bulk plan first.",
            );
          await c.mailboxDelete(path);
        }
        return { path: target ?? path, action };
      },
      true,
    );
  }
}
