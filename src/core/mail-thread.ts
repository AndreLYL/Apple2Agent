import type { ParsedMail } from "mailparser";
/** Connected headers within an already authorized, bounded snapshot. Subjects do not establish identity. */
export function threadComponent<
  T extends { message_ref: string; p: ParsedMail },
>(rows: T[], targetRef: string) {
  const edges = new Map<string, Set<string>>();
  let complete = true;
  const connect = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set());
    if (!edges.has(b)) edges.set(b, new Set());
    edges.get(a)!.add(b);
    edges.get(b)!.add(a);
  };
  for (const row of rows) {
    const node = `message:${row.message_ref}`;
    edges.set(node, edges.get(node) ?? new Set());
    const p = row.p;
    const headers = [
      p.messageId,
      p.inReplyTo,
      ...(Array.isArray(p.references)
        ? p.references
        : p.references
          ? [p.references]
          : []),
    ].filter((x): x is string => !!x);
    if (headers.length > 102) complete = false;
    for (const header of headers.slice(0, 102)) {
      if (header.length > 1000 || /[\r\n\0]/.test(header)) {
        complete = false;
        continue;
      }
      connect(node, `header:${header}`);
    }
  }
  const seen = new Set<string>(),
    queue = [`message:${targetRef}`];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of edges.get(node) ?? [])
      if (!seen.has(next)) queue.push(next);
  }
  return {
    messages: rows.filter((r) => seen.has(`message:${r.message_ref}`)),
    complete,
  };
}
