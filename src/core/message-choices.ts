import type { DatabaseSync } from "node:sqlite";

/** Build local picker choices from a supplied connection, without changing grants. */
export function messageSetupChoices(db: DatabaseSync) {
  const choices: { kind: string; id: string; label: string }[] = [];
  const rows = db
    .prepare(
      "SELECT ROWID AS rowid,guid,display_name,service_name FROM chat LIMIT 1000",
    )
    .all() as {
    rowid: number;
    guid: string;
    display_name: string;
    service_name: string;
  }[];
  const handles = new Set<string>();
  for (const chat of rows) {
    const people = (
      db
        .prepare(
          "SELECT h.id FROM handle h JOIN chat_handle_join j ON j.handle_id=h.ROWID WHERE j.chat_id=?",
        )
        .all(chat.rowid) as { id: string }[]
    ).map((r) => r.id);
    if (!people.length) continue;
    // Reading is scoped to the exact chat GUID. Short codes, local numbers and
    // alphanumeric SMS senders do not need to be valid outbound identities.
    choices.push({
      kind: "message_chats",
      id: chat.guid,
      label: `读取会话 ${chat.service_name}：${chat.display_name || people.join(", ")}`,
    });
    // Preserve the existing send eligibility separately. Adding a read choice
    // must never create an SMS recipient grant or relax the send allowlist.
    if (
      chat.service_name === "iMessage" &&
      people.every((p) => /@|^\+\d{6}/.test(p))
    ) {
      people.forEach((h) => handles.add(h));
    }
  }
  for (const h of handles) {
    choices.push({
      kind: "message_recipients",
      id: h,
      label: `允许审核后向这个精确身份发 iMessage：${h}`,
    });
  }
  return choices;
}
