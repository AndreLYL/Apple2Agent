import test from "node:test";
import assert from "node:assert/strict";
import { toolResult } from "../src/mcp/result.js";
test("4 MiB attachment bytes survive the MCP result without duplicating the payload past the Tunnel budget", () => {
  const raw = Buffer.alloc(4 * 1024 * 1024, 0x61),
    base64 = raw.toString("base64"),
    r = toolResult({ base64, size: raw.length });
  assert.ok(Buffer.byteLength(JSON.stringify(r)) < 8 * 1024 * 1024);
  assert.equal(
    Buffer.from(r.structuredContent.base64, "base64").compare(raw),
    0,
  );
  assert.ok(r.content[0]!.text.length < 100);
  const small = toolResult({ value: "small" });
  assert.deepEqual(JSON.parse(small.content[0]!.text), small.structuredContent);
});
test("oversized serialized responses fail explicitly instead of sending an invalid packet", () => {
  assert.throws(() => toolResult({ text: "x".repeat(9 * 1024 * 1024) }), {
    code: "CONTENT_TOO_LARGE",
  });
});
test("real stdio transports a 4 MiB authorized fixture file through the Drive tool with intact structured bytes", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { createHash } = await import("node:crypto");
  const { config } = await import("./fixtures.js");
  const { References } = await import("../src/core/references.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  const dir = await mkdtemp(join(tmpdir(), "a2a-large-stdio-")),
    root = join(dir, "files");
  await mkdir(root);
  const raw = Buffer.alloc(4 * 1024 * 1024, 0x61);
  await writeFile(join(root, "large.bin"), raw);
  const cfg = config();
  cfg.hub = { enabled_modules: ["drive"], drive_roots: [root] };
  await writeFile(join(dir, "config.json"), JSON.stringify(cfg), {
    mode: 0o600,
  });
  const refs = new References(cfg, cfg.ref_key),
    client = new Client({ name: "large-packet-test", version: "1" }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "serve",
        "--profile",
        "all",
      ],
      env: {
        ...(process.env as Record<string, string>),
        APPLE2AGENT_DATA_DIR: dir,
        DEBUG: "",
      },
      stderr: "pipe",
    });
  transport.stderr?.resume();
  try {
    await client.connect(transport);
    const result = await client.callTool(
      {
        name: "drive_get_file",
        arguments: {
          root_id: refs.encode("drive-root", { path: root }),
          path: "large.bin",
        },
      },
      undefined,
      { timeout: 30000 },
    );
    assert.equal(result.isError, false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8 * 1024 * 1024);
    const data = Buffer.from(
      (result.structuredContent as any).base64,
      "base64",
    );
    assert.equal(
      createHash("sha256").update(data).digest("hex"),
      createHash("sha256").update(raw).digest("hex"),
    );
  } finally {
    await client.close();
  }
});
