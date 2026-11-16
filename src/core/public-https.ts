import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { AppError } from "./errors.js";
export function isPublicAddress(ip: string) {
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number),
      a = p[0]!,
      b = p[1]!;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return (
      /^[23][0-9a-f]{3}:/.test(v) &&
      !v.startsWith("2001:db8:") &&
      !v.startsWith("2001:0:") &&
      !v.startsWith("2002:")
    );
  }
  return false;
}
export async function publicHTTPS(
  url: string,
  post: boolean,
  signal: AbortSignal,
  redirects = 0,
): Promise<{
  http_status: number;
  request_completed: boolean;
  unsubscribe_confirmed: false;
}> {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    isIP(u.hostname)
  )
    throw new AppError(
      "UNSAFE_ENDPOINT",
      "Unsubscribe requires a public HTTPS hostname without credentials.",
    );
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined,
    abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () =>
      reject(new AppError("TIMEOUT", "Unsubscribe DNS lookup was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, 5000);
    timer.unref();
  });
  let addresses: Awaited<ReturnType<typeof lookup>>[];
  try {
    addresses = (await Promise.race([
      lookup(u.hostname, { all: true, verbatim: true }),
      cancelled,
    ])) as any;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
  signal.throwIfAborted();
  if (!addresses.length || addresses.some((x) => !isPublicAddress(x.address)))
    throw new AppError(
      "UNSAFE_ENDPOINT",
      "The unsubscribe hostname resolves to a private or reserved address.",
    );
  const pinned = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method: post ? "POST" : "GET",
        signal,
        timeout: 10000,
        agent: false,
        lookup: ((_name: any, _opts: any, cb: any) =>
          cb(null, pinned.address, pinned.family)) as any,
        headers: {
          "User-Agent": "Apple2Agent/0.5",
          Accept: "text/plain",
          ...(post
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
        },
      },
      (res) => {
        let n = 0;
        res.on("data", (b: Buffer) => {
          n += b.length;
          if (n > 65536) {
            res.destroy();
            reject(
              new AppError(
                "CONTENT_TOO_LARGE",
                "Unsubscribe response exceeded 64 KiB.",
              ),
            );
          }
        });
        res.on("error", () =>
          reject(new AppError("NETWORK_ERROR", "Unsubscribe response failed.")),
        );
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            if (redirects >= 3 || !res.headers.location)
              return reject(
                new AppError(
                  "UNSAFE_ENDPOINT",
                  "Unsubscribe redirects exceeded the limit.",
                ),
              );
            if (post && [301, 302, 303].includes(status))
              return reject(
                new AppError(
                  "UNSAFE_ENDPOINT",
                  "Refusing an ambiguous unsubscribe POST redirect.",
                ),
              );
            publicHTTPS(
              new URL(res.headers.location, u).href,
              post,
              signal,
              redirects + 1,
            ).then(resolve, reject);
          } else
            resolve({
              http_status: status,
              request_completed: status >= 200 && status < 300,
              unsubscribe_confirmed: false,
            });
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () =>
      reject(
        new AppError("NETWORK_ERROR", "Unsubscribe request did not complete."),
      ),
    );
    req.end(post ? "List-Unsubscribe=One-Click" : undefined);
  });
}
