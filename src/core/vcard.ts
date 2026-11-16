import { AppError } from "./errors.js";
export type CardLine = { name: string; head: string; value: string };
export function parseCard(raw: string) {
  if (Buffer.byteLength(raw) > 1024 * 1024)
    throw new AppError("CONTENT_TOO_LARGE", "vCard exceeds 1 MiB.");
  const lines = raw
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      if (i < 1) throw new AppError("INVALID_VCARD", "Malformed vCard.");
      const head = l.slice(0, i);
      return {
        name: head.split(";")[0]!.split(".").at(-1)!.toUpperCase(),
        head,
        value: l.slice(i + 1),
      };
    });
  if (
    lines[0]?.name !== "BEGIN" ||
    lines.at(-1)?.name !== "END" ||
    !lines.some((l) => l.name === "UID")
  )
    throw new AppError("INVALID_VCARD", "vCard is missing identity.");
  return lines;
}
export function cardText(s: string) {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}
export function escapeCard(s: string) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}
export function value(c: CardLine[], name: string) {
  return cardText(c.find((l) => l.name === name)?.value ?? "");
}
export function isGroup(c: CardLine[]) {
  return (
    value(c, "KIND").toLowerCase() === "group" ||
    value(c, "X-ADDRESSBOOKSERVER-KIND").toLowerCase() === "group"
  );
}
export function setCard(c: CardLine[], name: string, values: CardLine[]) {
  const first = c.findIndex((l) => l.name === name),
    start = first < 0 ? c.length - 1 : first;
  return [
    ...c.slice(0, start).filter((l) => l.name !== name),
    ...values,
    ...c.slice(start).filter((l) => l.name !== name),
  ];
}
export function line(name: string, value: string) {
  return { name, head: name, value: escapeCard(value) };
}
export function serializeCard(c: CardLine[]) {
  return (
    c
      .map((l) => {
        const s = l.head + ":" + l.value;
        let out = "",
          n = 0;
        for (const ch of s) {
          const b = Buffer.byteLength(ch);
          if (n + b > 73) {
            out += "\r\n ";
            n = 1;
          }
          out += ch;
          n += b;
        }
        return out;
      })
      .join("\r\n") + "\r\n"
  );
}
export function contactView(c: CardLine[]) {
  return {
    uid: value(c, "UID"),
    name: value(c, "FN"),
    organization: value(c, "ORG"),
    job_title: value(c, "TITLE"),
    nickname: value(c, "NICKNAME"),
    birthday: value(c, "BDAY"),
    emails: c
      .filter((l) => l.name === "EMAIL")
      .map((l) => ({
        value: cardText(l.value),
        label: l.head.split(";").slice(1).join(";"),
      })),
    phones: c
      .filter((l) => l.name === "TEL")
      .map((l) => ({
        value: cardText(l.value),
        label: l.head.split(";").slice(1).join(";"),
      })),
    urls: c.filter((l) => l.name === "URL").map((l) => cardText(l.value)),
    addresses: c
      .filter((l) => l.name === "ADR")
      .map((l) => ({
        value: cardText(l.value),
        label: l.head.split(";").slice(1).join(";"),
      })),
    agent_added_emails: c
      .filter((l) => l.name === "X-APPLE2AGENT-EMAIL")
      .map((l) => cardText(l.value)),
  };
}
