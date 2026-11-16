import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("actual stdio MCP handshake, eight strict tools and configuration errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "apple2agent-stdio-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "serve"],
    env: { PATH: process.env.PATH!, APPLE2AGENT_DATA_DIR: directory },
    stderr: "pipe",
  });
  const client = new Client({
    name: "apple2agent-acceptance",
    version: "1.0.0",
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 8);
    for (const tool of listed.tools)
      assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(
      listed.tools.find((t) => t.name === "mail_draft_create")!.annotations!
        .readOnlyHint,
      false,
    );
    const status = await client.callTool({
      name: "apple_status",
      arguments: {},
    });
    assert.equal(status.isError, true);
    assert.equal(
      (status.structuredContent as any).error.code,
      "NOT_CONFIGURED",
    );
    const spoof = await client.callTool({
      name: "mail_search",
      arguments: { account_id: "other" },
    });
    assert.equal(spoof.isError, true);
  } finally {
    await client.close();
  }
});
