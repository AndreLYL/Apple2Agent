import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { ImapFlow } from "imapflow";
import { IMAPAdapter } from "../src/adapters/imap.js";
import { config } from "./fixtures.js";
import { allCapabilities } from "../src/core/context.js";

test("real ImapFlow protocol: EXAMINE, BODY.PEEK, Draft APPEND, UID search and stale references", async () => {
  const raw = Buffer.from(
    "From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Fixture\r\nMessage-ID: <fixture@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello fixture\r\n",
  );
  const messages = new Map<number, Buffer>([[1, raw]]);
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  let uidValidity = "11";
  let appends = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN UIDPLUS] fixture\r\n");
    let buffer = Buffer.alloc(0);
    let literal: { tag: string; size: number } | undefined;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (literal) {
          if (buffer.length < literal.size + 2) return;
          const content = buffer.subarray(0, literal.size);
          buffer = buffer.subarray(literal.size + 2);
          appends++;
          messages.set(2, content);
          socket.write(
            `${literal.tag} OK [APPENDUID ${uidValidity} 2] appended\r\n`,
          );
          literal = undefined;
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString();
        buffer = buffer.subarray(end + 2);
        if (!line) continue;
        const [tag, ...parts] = line.split(" ");
        const command = parts.join(" ");
        commands.push(
          command.replace(/AUTHENTICATE.*/, "AUTHENTICATE [fixture]"),
        );
        const done = (body = "") =>
          socket.write(body + `${tag} OK completed\r\n`);
        if (command.startsWith("CAPABILITY"))
          done("* CAPABILITY IMAP4rev1 AUTH=PLAIN UIDPLUS\r\n");
        else if (
          command.startsWith("AUTHENTICATE") ||
          command.startsWith("LOGIN")
        )
          done();
        else if (command === 'LIST "" ""')
          done('* LIST (\\Noselect) "/" ""\r\n');
        else if (command.startsWith("LIST"))
          done(
            '* LIST (\\Inbox) "/" "INBOX"\r\n* LIST (\\Drafts) "/" "Drafts"\r\n',
          );
        else if (command.startsWith("EXAMINE") || command.startsWith("SELECT"))
          done(
            `* FLAGS (\\Seen \\Draft)\r\n* ${messages.size} EXISTS\r\n* OK [UIDVALIDITY ${uidValidity}] valid\r\n* OK [UIDNEXT 3] next\r\n`,
          );
        else if (command.startsWith("UID SEARCH"))
          done(
            `* SEARCH ${command.includes("HEADER") ? (messages.has(2) ? "2" : "") : [...messages.keys()].join(" ")}\r\n`,
          );
        else if (command.startsWith("UID FETCH")) {
          const uid = Number(parts[2]);
          const content = messages.get(uid);
          if (!content) {
            done();
            continue;
          }
          const flags = uid === 2 ? "\\Draft" : "";
          const envelope =
            '("Fri, 13 Nov 2026 12:00:00 +0000" "Fixture" ((NIL NIL "sender" "example.com")) ((NIL NIL "sender" "example.com")) NIL ((NIL NIL "recipient" "example.com")) NIL NIL NIL "<fixture@example.com>")';
          socket.write(
            `* 1 FETCH (UID ${uid} FLAGS (${flags}) RFC822.SIZE ${content.length} ENVELOPE ${envelope} BODY[] {${content.length}}\r\n`,
          );
          socket.write(content);
          done(")\r\n");
        } else if (command.startsWith("APPEND")) {
          const match = /\{(\d+)\}$/.exec(command);
          assert.ok(match);
          assert.match(command, /\\Draft/);
          literal = { tag: tag!, size: Number(match[1]) };
          socket.write("+ ready for literal\r\n");
        } else if (command.startsWith("LOGOUT")) {
          socket.end(`* BYE\r\n${tag} OK logout\r\n`);
        } else if (command.startsWith("NOOP") || command.startsWith("CLOSE"))
          done();
        else socket.write(`${tag} BAD unsupported fixture command\r\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const cfg = config();
  const ctx = {
    ...cfg,
    actor_id: "wire-test",
    capabilities: new Set(allCapabilities),
    signal: AbortSignal.timeout(10000),
  };
  const adapter = new IMAPAdapter(
    cfg,
    { get: async () => "fixture" },
    (options) => {
      assert.equal(options.secure, true);
      assert.equal(options.logger, false);
      return new ImapFlow({
        ...options,
        host: "127.0.0.1",
        port,
        secure: false,
        doSTARTTLS: false,
        auth: { user: "fixture", pass: "fixture" },
      });
    },
  );
  try {
    assert.equal(
      (await adapter.folders(ctx)).find((f) => f.special_use === "\\Drafts")
        ?.path,
      "Drafts",
    );
    const found = await adapter.search(ctx, "INBOX", { all: true });
    assert.deepEqual(found.uids, [1]);
    const message = await adapter.read(
      ctx,
      { folder: "INBOX", uid: 1, uidvalidity: "11" },
      200,
    );
    assert.match(message.body_text, /hello fixture/);
    assert.equal(message.unread, true);
    await adapter.append(ctx, "Drafts", raw);
    assert.equal(appends, 1);
    const draft = await adapter.find(ctx, "Drafts", "<fixture@example.com>");
    assert.equal(draft?.draft, true);
    assert.equal(draft?.ref.uid, 2);
    uidValidity = "12";
    await assert.rejects(
      adapter.read(ctx, { folder: "INBOX", uid: 1, uidvalidity: "11" }, 200),
      { code: "STALE_REFERENCE" },
    );
    assert.ok(commands.some((c) => c.startsWith("EXAMINE")));
    assert.ok(commands.some((c) => c.includes("BODY.PEEK[")));
    assert.ok(!commands.some((c) => /STORE|EXPUNGE|MOVE/.test(c)));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
