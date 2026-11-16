import { readdir, lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HubState } from "./hub-state.js";
import { ApprovalStore } from "./approvals.js";
import { AppError } from "./errors.js";
/** Explicit local maintenance: private payload expiry never removes write deduplication tombstones. */
export async function maintenance(
  directory: string,
  state: HubState,
  approvals: ApprovalStore,
  retentionDays = 30,
) {
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 365
  )
    throw new AppError("INVALID_INPUT", "Backup retention must be 1–365 days.");
  const result = {
    ...approvals.prune(),
    removed_backups: 0,
    expired_change_snapshots: 0,
    expired_bulk_payloads: 0,
    retention_days: retentionDays,
  };
  for (const kind of ["notes", "drive", "calendar"]) {
    const dir = join(directory, "backups", kind);
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new AppError(
          "PERMISSION_DENIED",
          "Backup directory is not a regular private directory.",
        );
      for (const name of (await readdir(dir)).slice(0, 10000)) {
        const pattern =
          kind === "calendar"
            ? /^[a-f0-9]{64}\.ics$/
            : /^[a-f0-9]{64}\.(json|bin)$/;
        if (!pattern.test(name)) continue;
        const path = join(dir, name),
          info = await lstat(path);
        if (
          info.isFile() &&
          !info.isSymbolicLink() &&
          info.mtimeMs < Date.now() - retentionDays * 86400000
        ) {
          await unlink(path);
          result.removed_backups++;
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  for (const entry of state.entries<any>("mail-changes:"))
    if (entry.value.expires < Date.now()) {
      state.remove(entry.key);
      result.expired_change_snapshots++;
    }
  for (const entry of state.entries<any>("mail-bulk:"))
    if (
      !entry.value.expired &&
      entry.value.created < Date.now() - 30 * 86400000
    ) {
      state.put(entry.key, {
        account_id: entry.value.account_id,
        digest: entry.value.digest,
        created: entry.value.created,
        expired: true,
      });
      result.expired_bulk_payloads++;
    }
  return { ...result, retained_write_journal: true };
}
