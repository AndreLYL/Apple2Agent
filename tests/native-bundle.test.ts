import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const available =
  process.platform === "darwin" &&
  existsSync("bin/automation.app/Contents/Resources/automation-bridge.js");

test(
  "signed automation app executes its bundled bridge after relocation without the source checkout",
  { skip: !available },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "a2a-relocated-app-"));
    cpSync("bin/automation.app", join(dir, "automation.app"), {
      recursive: true,
    });
    const r = spawnSync(
      join(dir, "automation.app/Contents/MacOS/automation"),
      [],
      {
        input: JSON.stringify({ operation: "not_an_operation", args: {} }),
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(JSON.parse(r.stdout).error.code, "INVALID_INPUT");
    assert.equal(
      spawnSync("/usr/bin/codesign", [
        "--verify",
        "--deep",
        "--strict",
        join(dir, "automation.app"),
      ]).status,
      0,
    );
  },
);

test(
  "standalone automation helper runs with only its packaged sidecar, not native source",
  { skip: !available },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "a2a-relocated-binary-"));
    cpSync("bin/automation", join(dir, "automation"));
    cpSync("bin/automation-bridge.js", join(dir, "automation-bridge.js"));
    const r = spawnSync(join(dir, "automation"), [], {
      input: JSON.stringify({ operation: "not_an_operation", args: {} }),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(JSON.parse(r.stdout).error.code, "INVALID_INPUT");
  },
);

test(
  "bundled reminders status reports a stable privacy identity without asking permission",
  { skip: !available },
  () => {
    const r = spawnSync("bin/reminders.app/Contents/MacOS/reminders", [], {
      input: JSON.stringify({ operation: "authorization_status", args: {} }),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(r.status, 0);
    const data = JSON.parse(r.stdout);
    assert.equal(data.bundle_identifier, "com.apple2agent.reminders");
    assert.equal(data.usage_description_present, true);
    assert.equal(typeof data.raw_status, "number");
  },
);
