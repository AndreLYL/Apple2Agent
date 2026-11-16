import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { AppError } from "./errors.js";
import type { AccessContext } from "./context.js";
export interface NativeBridge {
  call<T = any>(
    ctx: AccessContext,
    helper: string,
    operation: string,
    args: unknown,
  ): Promise<T>;
}
export function nativeExecutable(helper: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(helper))
    throw new AppError("INVALID_INPUT", "Invalid native helper name.");
  const bundled = fileURLToPath(
    new URL(
      `../../bin/${helper}.app/Contents/MacOS/${helper}`,
      import.meta.url,
    ),
  );
  return existsSync(bundled)
    ? bundled
    : fileURLToPath(new URL(`../../bin/${helper}`, import.meta.url));
}
export class ProcessNativeBridge implements NativeBridge {
  async call<T>(
    ctx: AccessContext,
    helper: string,
    operation: string,
    args: unknown,
  ): Promise<T> {
    if (
      !["reminders", "automation", "action-approval", "drive"].includes(helper)
    )
      throw new AppError("INVALID_INPUT", "Unknown native helper.");
    ctx.signal.throwIfAborted();
    ctx.assert_current?.();
    const path = nativeExecutable(helper);
    return new Promise((resolve, reject) => {
      const child = spawn(path, [], {
        stdio: ["pipe", "pipe", "pipe"],
        signal: ctx.signal,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: process.env.HOME!,
          LANG: "en_US.UTF-8",
        },
      });
      let size = 0,
        raw = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (b: string) => {
        size += Buffer.byteLength(b);
        if (size > 12 * 1024 * 1024) {
          child.kill();
          reject(
            new AppError(
              "CONTENT_TOO_LARGE",
              "Native response exceeded the limit.",
            ),
          );
        } else raw += b;
      });
      child.stderr.resume(); // Never forward user content or native error details into logs.
      child.on("error", () =>
        reject(
          new AppError(
            ctx.signal.aborted ? "TIMEOUT" : "HELPER_UNAVAILABLE",
            "Native helper could not complete.",
            "Build helpers or check this Mac session.",
          ),
        ),
      );
      child.on("close", () => {
        try {
          const v = JSON.parse(raw);
          if (v.error)
            reject(
              new AppError(
                v.error.code ?? "NATIVE_ERROR",
                v.error.message ?? "Native operation failed.",
                v.error.next_action ?? "Check module permissions.",
                false,
                v.error.write_state,
              ),
            );
          else resolve(v as T);
        } catch {
          reject(
            new AppError(
              "HELPER_UNAVAILABLE",
              "Native helper did not return a structured result.",
              "Build the signed helpers and check permissions.",
            ),
          );
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ operation, args }));
    });
  }
}
