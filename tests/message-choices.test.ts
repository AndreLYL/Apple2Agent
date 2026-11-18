import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { messageSetupChoices } from "../src/core/message-choices.js";

test("local picker accepts SMS short, local and alphanumeric senders only as exact read-chat choices", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE chat(guid TEXT,display_name TEXT,service_name TEXT);
      CREATE TABLE handle(id TEXT);CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER);`);
    const chats = [
      ["sms-short", "SMS", "12345"],
      ["sms-local", "SMS", "0123456789"],
      ["sms-alpha", "SMS", "ExampleService"],
      ["sms-international", "SMS", "+15555550123"],
      ["im-valid", "iMessage", "sender@example.com"],
      ["im-phone", "iMessage", "+15555550124"],
      ["im-invalid", "iMessage", "54321"],
    ];
    for (const [guid, service, handle] of chats) {
      const c = db
        .prepare("INSERT INTO chat VALUES(?,?,?)")
        .run(guid!, "", service!).lastInsertRowid;
      const h = db
        .prepare("INSERT INTO handle VALUES(?)")
        .run(handle!).lastInsertRowid;
      db.prepare("INSERT INTO chat_handle_join VALUES(?,?)").run(c, h);
    }
    db.exec("PRAGMA query_only=ON");
    const choices = messageSetupChoices(db);
    assert.deepEqual(
      choices.filter((c) => c.kind === "message_chats").map((c) => c.id),
      chats.map((c) => c[0]),
    );
    assert.deepEqual(
      choices.filter((c) => c.kind === "message_recipients").map((c) => c.id),
      ["sender@example.com", "+15555550124"],
    );
    assert.ok(
      choices
        .filter((c) => c.kind === "message_chats")
        .every((c) => c.label.startsWith("读取会话")),
    );
    assert.equal(
      choices.some(
        (c) =>
          c.kind === "message_recipients" &&
          [
            "12345",
            "0123456789",
            "ExampleService",
            "+15555550123",
            "54321",
          ].includes(c.id),
      ),
      false,
    );
  } finally {
    db.close();
  }
});
