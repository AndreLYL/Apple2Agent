import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("independent Node processes atomically share one operation claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple2agent-process-"));
  const db = join(directory, "ops.sqlite");
  const module = fileURLToPath(
    new URL("../dist/core/operations.js", import.meta.url),
  );
  const code = `import {SQLiteOperationStore} from ${JSON.stringify(module)}; const store=new SQLiteOperationStore(process.argv[1]); console.log(JSON.stringify(store.claim('same-key','same-input'))); store.close();`;
  const run = () =>
    promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", code, db],
      { timeout: 10000 },
    );
  const results = await Promise.all([run(), run()]);
  assert.equal(
    results.map((r) => JSON.parse(r.stdout)).filter((r) => r.fresh).length,
    1,
  );
});
