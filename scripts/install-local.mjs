#!/usr/bin/env node
import {
  cp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  lstat,
  readdir,
  readlink,
  realpath,
  rename,
  symlink,
  rm,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const exists = async (p) =>
  lstat(p).then(
    () => true,
    (e) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  );
const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";

async function manifest(directory) {
  const entries = {};
  async function walk(relative) {
    const absolute = join(directory, relative),
      stat = await lstat(absolute);
    if (stat.isSymbolicLink())
      entries[relative] = { link: await readlink(absolute) };
    else if (stat.isDirectory()) {
      for (const name of (await readdir(absolute)).sort())
        await walk(join(relative, name));
    } else
      entries[relative] = {
        mode: stat.mode & 0o777,
        sha256: createHash("sha256")
          .update(await readFile(absolute))
          .digest("hex"),
      };
  }
  for (const path of ["dist", "bin", "package.json", "package-lock.json"])
    await walk(path);
  return entries;
}

async function verify(directory, expected) {
  if (JSON.stringify(await manifest(directory)) !== JSON.stringify(expected))
    throw new Error(
      "Installed artifacts differ from the built source artifacts.",
    );
  for (const name of [
    "automation.app",
    "reminders.app",
    "ResourcePicker.app",
    "TunnelPicker.app",
    "MailProviderPicker.app",
    "action-approval.app",
    "keychain-helper",
    "drive",
  ])
    execFileSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", join(directory, "bin", name)],
      { stdio: "pipe" },
    );
  await readFile(
    join(
      directory,
      "bin/automation.app/Contents/Resources/automation-bridge.js",
    ),
  );
  const version = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  ).version;
  const actual = execFileSync(
    process.execPath,
    [join(directory, "dist/cli.js"), "--version"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  if (actual !== version)
    throw new Error("Installed CLI version differs from the package version.");
}

async function main() {
  if (
    process.platform !== "darwin" ||
    Number(process.versions.node.split(".")[0]) < 24
  )
    throw new Error(
      "Local installation requires macOS and Node.js 24 or later.",
    );
  if (git("status", "--porcelain"))
    throw new Error(
      "Commit source changes before installing an immutable release.",
    );
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const { VERSION } = await import(
    pathToFileURL(join(root, "dist/core/version.js")).href
  );
  if (VERSION !== pkg.version)
    throw new Error("Build the current version before installing.");
  const commit = git("rev-parse", "HEAD"),
    sourceManifest = await manifest(root);
  const installRoot = join(homedir(), ".local/share/apple2agent");
  const releases = join(installRoot, "releases"),
    release = join(releases, `${pkg.version}-${commit.slice(0, 12)}`);
  await mkdir(releases, { recursive: true, mode: 0o700 });
  if (!(await exists(release))) {
    const staging = join(releases, `.staging-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      // Copy app directories recursively: their Info.plist, signatures and JS
      // resources are part of the runtime, not optional build-time files.
      for (const name of [
        "dist",
        "bin",
        "package.json",
        "package-lock.json",
      ])
        await cp(join(root, name), join(staging, name), {
          recursive: true,
          verbatimSymlinks: true,
        });
      execFileSync(
        process.execPath,
        [process.env.npm_execpath || "", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: staging, stdio: "pipe", timeout: 120000 },
      );
      await verify(staging, sourceManifest);
      await writeFile(
        join(staging, "release.json"),
        JSON.stringify(
          {
            version: pkg.version,
            commit,
            node: process.execPath,
            artifacts: sourceManifest,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await rename(staging, release);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }); // Only our new staging directory.
      throw error;
    }
  }
  await verify(release, sourceManifest);
  const current = join(installRoot, "current");
  if (await exists(current)) {
    if (!(await lstat(current)).isSymbolicLink())
      throw new Error(
        "The current installation is not a symlink; leaving it untouched.",
      );
    const oldRelease = await realpath(current),
      previousTemp = join(installRoot, `.previous-${randomUUID()}`);
    if (oldRelease !== release) {
      await symlink(oldRelease, previousTemp);
      await rename(previousTemp, join(installRoot, "previous"));
    }
  }
  const next = join(installRoot, `.current-${randomUUID()}`);
  await symlink(release, next);
  await rename(next, current);
  const bin = join(homedir(), ".local/bin");
  await mkdir(bin, { recursive: true });
  const launcher = join(bin, "apple2agent"),
    temporaryLauncher = join(bin, `.apple2agent-${randomUUID()}`);
  await writeFile(
    temporaryLauncher,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(current, "dist/cli.js"))} "$@"\n`,
    { mode: 0o700 },
  );
  await chmod(temporaryLauncher, 0o700);
  await rename(temporaryLauncher, launcher);
  console.log(
    JSON.stringify({
      installed: true,
      version: pkg.version,
      commit,
      release,
      launcher,
      artifacts_verified: true,
      signatures_verified: true,
    }),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
