import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, isAbsolute } from "node:path";
import {
  lstat,
  readFile,
  mkdir,
  writeFile,
  chmod,
  realpath,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";
const schema = z
  .object({
    client: z.string(),
    tunnel_id: z.string().regex(/^tunnel_[\w-]{8,128}$/),
    key_file: z.string(),
    alias: z.literal("apple2agent"),
    profile: z.enum(["calendar", "all"]),
  })
  .strict();
export const quoteShell = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export function runtimeSummary(value: any) {
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const known = new Set([
    "running",
    "stopped",
    "healthy",
    "unhealthy",
    "ready",
    "starting",
    "not_ready",
    "disconnected",
    "failed",
    "error",
  ]);
  const state = value?.status ?? value?.runtime_state;
  return {
    running: bool(
      value?.process_running ??
        value?.running ??
        value?.runtime?.process_running ??
        value?.runtime?.running,
    ),
    healthy: bool(value?.healthy ?? value?.runtime?.healthy),
    ready: bool(value?.ready ?? value?.runtime?.ready),
    status: typeof state === "string" && known.has(state) ? state : null,
  };
}
export async function connector(
  directory: string,
  action: "connect" | "status",
) {
  let c: z.infer<typeof schema>;
  try {
    const p = join(directory, "connector", "connector.json"),
      st = await lstat(p);
    if (st.isSymbolicLink() || st.mode & 0o077) throw new Error();
    c = schema.parse(JSON.parse(await readFile(p, "utf8")));
  } catch {
    throw new AppError(
      "NOT_CONFIGURED",
      "Private Connector is not configured.",
      "Run connector-configure on this Mac.",
    );
  }
  if (!isAbsolute(c.client) || !isAbsolute(c.key_file))
    throw new AppError("NOT_CONFIGURED", "Connector paths must be absolute.");
  const key = await lstat(c.key_file);
  if (
    key.isSymbolicLink() ||
    key.mode & 0o077 ||
    key.size < 20 ||
    !key.isFile()
  )
    throw new AppError(
      "PERMISSION_DENIED",
      "Runtime key must be a private regular file.",
    );
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const profileDir = join(directory, "connector", "native-profiles");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
  const wrapper = join(directory, "connector", "serve.sh");
  if (action === "connect") {
    const command = `#!/bin/sh\nexport APPLE2AGENT_DATA_DIR=${quoteShell(directory)}\nexec ${quoteShell(process.execPath)} ${quoteShell(cli)} serve --profile ${quoteShell(c.profile)}\n`;
    await writeFile(wrapper, command, { mode: 0o700 });
    await chmod(wrapper, 0o700);
  }
  const args =
    action === "connect"
      ? [
          "runtimes",
          "connect",
          "--alias",
          c.alias,
          "--tunnel-id",
          c.tunnel_id,
          "--profile",
          `apple2agent-${c.profile}`,
          "--profile-dir",
          profileDir,
          "--runtime-api-key",
          `file:${c.key_file}`,
          "--mcp-command",
          quoteShell(wrapper),
          "--json",
        ]
      : ["runtimes", "status", c.alias, "--json"];
  let value: any;
  try {
    const { stdout } = await promisify(execFile)(c.client, args, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        DEBUG: "",
        CONTROL_PLANE_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      },
    });
    value = JSON.parse(stdout);
  } catch {
    throw new AppError(
      "CONNECTOR_UNAVAILABLE",
      "Tunnel client did not complete the requested action.",
      "Check dedicated Tunnel permissions and run connector-status. Raw key-bearing output is suppressed.",
    );
  }
  // Do not return raw runtime config, credential references, stderr, or log tails.
  return {
    alias: c.alias,
    profile: c.profile,
    action,
    ...runtimeSummary(value),
    mobile_e2e_verified: false,
    trusted_mobile_send_approval: "local_native_review_required",
    next_action:
      action === "connect"
        ? "Run connector-status, then verify a read and explicit calendar create from each phone entry."
        : undefined,
  };
}
