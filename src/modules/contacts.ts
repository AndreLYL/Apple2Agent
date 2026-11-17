import { toolDescription } from "../core/tool-descriptions.js";
import { z } from "zod";
import { parseBirthday } from "../core/birthday.js";
import { searchText } from "../core/search-text.js";
import { Temporal } from "@js-temporal/polyfill";
import {
  authorize,
  requireGrant,
  type AccessContext,
} from "../core/context.js";
import type { Config } from "../core/config.js";
import type { CardProvider, CardObject } from "../adapters/carddav.js";
import { References, hash } from "../core/references.js";
import { HubState } from "../core/hub-state.js";
import { AppError } from "../core/errors.js";
import {
  parseCard,
  isGroup,
  value,
  contactView,
  setCard,
  line,
  serializeCard,
  escapeCard,
  type CardLine,
} from "../core/vcard.js";
import type { Module, ToolRegistry } from "./types.js";
const id = z.string().min(1).max(16384),
  text = z.string().max(2000),
  request_id = z.uuid(),
  entry = z
    .object({
      value: text,
      label: z.enum(["HOME", "WORK", "CELL", "OTHER"]).default("OTHER"),
    })
    .strict();
const fields = {
  name: z.string().min(1).max(1000).optional(),
  organization: text.optional(),
  job_title: text.optional(),
  nickname: text.optional(),
  birthday: z
    .string()
    .max(10)
    .refine((v) => !!parseBirthday(v))
    .optional(),
  emails: z
    .array(entry.extend({ value: z.email() }))
    .max(30)
    .optional(),
  phones: z.array(entry).max(30).optional(),
  urls: z.array(z.url()).max(20).optional(),
  addresses: z
    .array(
      z
        .object({
          street: text.default(""),
          city: text.default(""),
          region: text.default(""),
          postal_code: text.default(""),
          country: text.default(""),
          po_box: text.default(""),
          extended: text.default(""),
          label: z.enum(["HOME", "WORK", "OTHER"]).default("OTHER"),
        })
        .strict(),
    )
    .max(20)
    .optional(),
  replace_lists: z.boolean().default(false),
};
export class ContactsModule implements Module {
  domain = "contacts" as const;
  tools: ToolRegistry = {};
  constructor(
    private config: Config,
    private provider: CardProvider,
    private refs: References,
    private state: HubState,
  ) {
    const add = (
      name: string,
      schema: z.ZodType,
      op: string,
      cap: "contacts:read" | "contacts:write" | "contacts:delete",
    ) =>
      (this.tools[name] = {
        schema,
        capability: cap,
        destructive: cap === "contacts:delete",
        description: toolDescription(name),
        run: (ctx, a) => this.run(ctx, op, a, cap),
      });
    add(
      "contacts_list_addressbooks",
      z.object({}).strict(),
      "books",
      "contacts:read",
    );
    add(
      "contacts_search_contacts",
      z
        .object({
          addressbook_id: id,
          query: text,
          limit: z.number().int().min(1).max(100).default(30),
          cursor: id.optional(),
          fuzzy: z.boolean().default(false),
        })
        .strict(),
      "search",
      "contacts:read",
    );
    add(
      "contacts_list_birthdays",
      z
        .object({
          addressbook_id: id,
          from: z.iso.date(),
          days: z.number().int().min(1).max(366).default(30),
        })
        .strict(),
      "birthdays",
      "contacts:read",
    );
    add(
      "contacts_list_groups",
      z.object({ addressbook_id: id }).strict(),
      "groups",
      "contacts:read",
    );
    for (const kind of ["contact", "group"] as const) {
      add(
        `contacts_get_${kind}`,
        z.object({ id }).strict(),
        `get_${kind}`,
        "contacts:read",
      );
      add(
        `contacts_delete_${kind}`,
        z.object({ id, expected_revision: id, request_id }).strict(),
        `delete_${kind}`,
        "contacts:delete",
      );
    }
    add(
      "contacts_create_contact",
      z
        .object({
          ...fields,
          name: fields.name.unwrap(),
          addressbook_id: id,
          request_id,
        })
        .strict(),
      "create_contact",
      "contacts:write",
    );
    add(
      "contacts_update_contact",
      z.object({ ...fields, id, expected_revision: id, request_id }).strict(),
      "update_contact",
      "contacts:write",
    );
    add(
      "contacts_create_group",
      z
        .object({
          addressbook_id: id,
          name: text,
          members: z.array(id).max(500).default([]),
          request_id,
        })
        .strict(),
      "create_group",
      "contacts:write",
    );
    add(
      "contacts_update_group",
      z
        .object({
          id,
          expected_revision: id,
          name: text.optional(),
          add_members: z.array(id).max(500).default([]),
          remove_members: z.array(id).max(500).default([]),
          request_id,
        })
        .strict(),
      "update_group",
      "contacts:write",
    );
  }
  async status(ctx: AccessContext) {
    authorize(ctx, this.config, "contacts:read");
    return {
      status: ctx.grants?.addressbooks?.length
        ? "configured"
        : "not_configured",
      addressbook_count: ctx.grants?.addressbooks?.length ?? 0,
    };
  }
  private async book(ctx: AccessContext, id: string) {
    const b = this.refs.decode<string>("addressbook", id);
    requireGrant(ctx, "addressbooks", b);
    if (!(await this.provider.books(ctx)).some((x) => x.url === b))
      throw new AppError("STALE_REFERENCE", "Address book no longer exists.");
    return b;
  }
  private async object(ctx: AccessContext, id: string) {
    const ref = this.refs.decode<any>("card", id);
    await this.book(ctx, this.refs.encode("addressbook", ref.book));
    if (!ref.url.startsWith(ref.book.endsWith("/") ? ref.book : ref.book + "/"))
      throw new AppError(
        "STALE_REFERENCE",
        "Contact is outside its address book.",
      );
    const o = await this.provider.get(ctx, ref.url);
    if (!o) throw new AppError("NOT_FOUND", "Contact no longer exists.");
    const c = parseCard(o.data);
    if (value(c, "UID") !== ref.uid)
      throw new AppError("STALE_REFERENCE", "Contact identity changed.");
    return { ref, o, c };
  }
  private present(book: string, o: CardObject, c: CardLine[]) {
    return {
      id: this.refs.encode("card", { book, url: o.url, uid: value(c, "UID") }),
      revision:
        o.etag && !o.etag.startsWith("W/")
          ? this.refs.encode("card-revision", { url: o.url, etag: o.etag })
          : undefined,
      kind: isGroup(c) ? "group" : "contact",
      ...(isGroup(c)
        ? {
            name: value(c, "FN"),
            members: c
              .filter(
                (l) =>
                  l.name === "X-ADDRESSBOOKSERVER-MEMBER" ||
                  l.name === "MEMBER",
              )
              .map((l) => l.value.replace(/^urn:uuid:/i, "")),
          }
        : contactView(c)),
    };
  }
  private async run(
    ctx: AccessContext,
    op: string,
    a: any,
    cap: "contacts:read" | "contacts:write" | "contacts:delete",
  ): Promise<any> {
    authorize(ctx, this.config, cap);
    if (op === "books")
      return {
        addressbooks: (await this.provider.books(ctx))
          .filter((b) => ctx.grants?.addressbooks?.includes(b.url))
          .map((b) => ({
            id: this.refs.encode("addressbook", b.url),
            name: b.name,
          })),
      };
    if (["search", "groups", "birthdays"].includes(op)) {
      const book = await this.book(ctx, a.addressbook_id),
        rows: any[] = [],
        warnings: string[] = [];
      for (const o of await this.provider.cards(ctx, book)) {
        try {
          const c = parseCard(o.data);
          if (isGroup(c) !== (op === "groups")) continue;
          rows.push(this.present(book, o, c));
        } catch {
          warnings.push("One malformed vCard was skipped.");
        }
      }
      rows.sort((x, y) => x.id.localeCompare(y.id));
      if (op === "groups")
        return {
          groups: rows,
          complete: !warnings.length,
          warnings,
          refreshed_at: new Date().toISOString(),
        };
      if (op === "birthdays") {
        const start = Temporal.PlainDate.from(a.from),
          end = start.add({ days: a.days }),
          birthdays: any[] = [];
        for (const r of rows) {
          if (!r.birthday) continue;
          const birthday = parseBirthday(String(r.birthday));
          if (!birthday) {
            warnings.push("One invalid or unsupported birthday was skipped.");
            continue;
          }
          for (const year of [start.year, start.year + 1]) {
            if (birthday.year !== undefined && birthday.year > year) continue;
            const leap = Temporal.PlainDate.from({
              year,
              month: 1,
              day: 1,
            }).inLeapYear;
            const date = Temporal.PlainDate.from(
              {
                year,
                month: birthday.month,
                day:
                  birthday.month === 2 && birthday.day === 29 && !leap
                    ? 28
                    : birthday.day,
              },
              { overflow: "reject" },
            );
            if (
              Temporal.PlainDate.compare(date, start) >= 0 &&
              Temporal.PlainDate.compare(date, end) < 0
            )
              birthdays.push({
                ...r,
                next_birthday: date.toString(),
                age:
                  birthday.year === undefined
                    ? undefined
                    : year - birthday.year,
              });
          }
        }
        return {
          birthdays: birthdays.sort((x, y) =>
            x.next_birthday.localeCompare(y.next_birthday),
          ),
          leap_day_policy: "February 28 in non-leap years",
          complete: !warnings.length,
          warnings,
        };
      }
      const q = searchText(a.query),
        filtered = rows
          .map((r) => {
            const hay = searchText(
              JSON.stringify([
                r.name,
                r.organization,
                r.nickname,
                r.emails,
                r.phones,
              ]),
            );
            const exact = hay.includes(q);
            const fuzzy =
              !exact &&
              a.fuzzy &&
              q.length > 2 &&
              q.split(/\s+/).every((t: string) => hay.includes(t));
            return {
              ...r,
              match: exact ? "substring" : "fuzzy_candidate",
              matched: exact || fuzzy,
            };
          })
          .filter((r) => r.matched);
      const page = this.refs.page(
        filtered,
        { op, ...a, cursor: undefined },
        a.limit,
        a.cursor,
      );
      return {
        ...page,
        complete: !warnings.length && !page.next_cursor,
        warnings,
        refreshed_at: new Date().toISOString(),
      };
    }
    if (op.startsWith("get_")) {
      const { ref, o, c } = await this.object(ctx, a.id);
      if (isGroup(c) !== op.endsWith("group"))
        throw new AppError("INVALID_INPUT", "Wrong object kind.");
      return this.present(ref.book, o, c);
    }
    const operation = `contacts:${op}`,
      proofKey = `contacts-proof:${hash([ctx.owner_id, ctx.account_id, operation, a.request_id])}`;
    const isCreate = op.startsWith("create");
    const scopedRef = isCreate
      ? undefined
      : this.refs.decode<any>("card", a.id);
    const scopedBook = isCreate
      ? this.refs.decode<string>("addressbook", a.addressbook_id)
      : scopedRef.book;
    requireGrant(ctx, "addressbooks", scopedBook);
    if (this.state.hasWrite(ctx, operation, a.request_id))
      return this.state.locked(ctx, "contacts", () =>
        this.state.write(ctx, operation, a.request_id, a, {
          verification_scope: "server",
          prepare: async () => {
            throw new AppError(
              "OUTCOME_UNKNOWN",
              "Recovery cannot issue another write.",
            );
          },
          write: async () => ({ id: a.id }),
          verify: async (receipt) => {
            const proof = this.state.get<any>(proofKey);
            if (!proof) return undefined;
            const found = await this.provider.get(ctx, proof.url);
            const id = this.refs.encode("card", {
              book: scopedBook,
              url: proof.url,
              uid: proof.uid,
            });
            if (op.startsWith("delete"))
              return found ? undefined : { id, deleted: true };
            if (!found) return undefined;
            const card = parseCard(found.data);
            if (
              hash(card) !== proof.expected ||
              value(card, "X-APPLE2AGENT-OPERATION") !== a.request_id
            )
              return undefined;
            return {
              id,
              revision: this.present(scopedBook, found, card).revision,
              deleted: false,
            };
          },
        }),
      );
    return this.state.locked(ctx, "contacts", async () => {
      const create = op.startsWith("create"),
        group = op.endsWith("group");
      let book: string, url: string, c: CardLine[], etag: string | undefined;
      if (create) {
        book = await this.book(ctx, a.addressbook_id);
        const uid = `apple2agent-${hash([ctx.owner_id, op, a.request_id]).slice(0, 32)}`;
        url = new URL(`${uid}.vcf`, book.endsWith("/") ? book : book + "/")
          .href;
        c = [
          line("BEGIN", "VCARD"),
          line("VERSION", "3.0"),
          line("UID", uid),
          line("FN", a.name),
          line("END", "VCARD"),
        ];
        if (group)
          c = setCard(c, "X-ADDRESSBOOKSERVER-KIND", [
            line("X-ADDRESSBOOKSERVER-KIND", "group"),
          ]);
      } else {
        const current = await this.object(ctx, a.id);
        ({ book, url } = current.ref);
        c = current.c;
        const rev = this.refs.decode<any>("card-revision", a.expected_revision);
        if (
          rev.url !== url ||
          rev.etag !== current.o.etag ||
          !rev.etag ||
          rev.etag.startsWith("W/")
        )
          throw new AppError(
            "STALE_REVISION",
            "Contact changed since it was read.",
          );
        etag = rev.etag;
        if (isGroup(c) !== group)
          throw new AppError("INVALID_INPUT", "Wrong contact/group kind.");
      }
      if (!op.startsWith("delete")) {
        for (const [key, property] of Object.entries({
          name: "FN",
          organization: "ORG",
          job_title: "TITLE",
          nickname: "NICKNAME",
          birthday: "BDAY",
        }))
          if (a[key] !== undefined)
            c = setCard(c, property, [line(property, a[key])]);
        if (!group) {
          for (const [key, p] of [
            ["emails", "EMAIL"],
            ["phones", "TEL"],
            ["addresses", "ADR"],
            ["urls", "URL"],
          ] as const) {
            if (a[key] === undefined) continue;
            const previous = c.filter((l) => l.name === p);
            const next: CardLine[] = a[key].map((v: any) => ({
              name: p,
              head: p + (typeof v === "string" ? "" : `;TYPE=${v.label}`),
              value:
                p === "ADR"
                  ? [
                      v.po_box,
                      v.extended,
                      v.street,
                      v.city,
                      v.region,
                      v.postal_code,
                      v.country,
                    ]
                      .map((x: string) => escapeCard(x))
                      .join(";")
                  : escapeCard(typeof v === "string" ? v : v.value),
            }));
            c = setCard(
              c,
              p,
              a.replace_lists
                ? next
                : [
                    ...c.filter((l) => l.name === p),
                    ...next.filter(
                      (l) =>
                        !c.some((x) => x.name === p && x.value === l.value),
                    ),
                  ],
            );
            if (p === "EMAIL")
              c = setCard(c, "X-APPLE2AGENT-EMAIL", [
                ...c.filter((l) => l.name === "X-APPLE2AGENT-EMAIL"),
                ...a[key]
                  .filter(
                    (v: any) =>
                      !previous.some(
                        (x) => x.value.toLowerCase() === v.value.toLowerCase(),
                      ),
                  )
                  .map((v: any) => line("X-APPLE2AGENT-EMAIL", v.value)),
              ]);
          }
        } else {
          let members = c
            .filter((l) =>
              ["MEMBER", "X-ADDRESSBOOKSERVER-MEMBER"].includes(l.name),
            )
            .map((l) => l.value.replace(/^urn:uuid:/i, ""));
          for (const member of a.remove_members ?? []) {
            const r = await this.object(ctx, member);
            if (r.ref.book !== book || isGroup(r.c))
              throw new AppError(
                "INVALID_INPUT",
                "Group member must be a contact in the same book.",
              );
            members = members.filter((x) => x !== r.ref.uid);
          }
          for (const member of a.members ?? a.add_members ?? []) {
            const r = await this.object(ctx, member);
            if (r.ref.book !== book || isGroup(r.c))
              throw new AppError(
                "INVALID_INPUT",
                "Group member must be a contact in the same book.",
              );
            members.push(r.ref.uid);
          }
          c = setCard(c, "MEMBER", []);
          c = setCard(
            c,
            "X-ADDRESSBOOKSERVER-MEMBER",
            [...new Set(members)].map((uid) => ({
              name: "X-ADDRESSBOOKSERVER-MEMBER",
              head: "X-ADDRESSBOOKSERVER-MEMBER",
              value: `urn:uuid:${uid}`,
            })),
          );
        }
        c = setCard(c, "X-APPLE2AGENT-OPERATION", [
          line("X-APPLE2AGENT-OPERATION", a.request_id),
        ]);
      }
      const data = serializeCard(c),
        expected = hash(parseCard(data));
      const uid = value(c, "UID"),
        resource = {
          id: this.refs.encode("card", { book, url, uid }),
          deleted: op.startsWith("delete"),
        };
      return this.state.write(ctx, `contacts:${op}`, a.request_id, a, {
        verification_scope: "server",
        prepare: async () => {
          this.state.put(proofKey, { url, uid, expected });
        },
        write: async () => {
          if (resource.deleted) await this.provider.remove(ctx, url, etag!);
          else await this.provider.put(ctx, url, data, etag);
          return resource;
        },
        verify: async () => {
          const found = await this.provider.get(ctx, url);
          if (resource.deleted) return found ? undefined : resource;
          if (!found) return undefined;
          const current = parseCard(found.data);
          if (
            value(current, "X-APPLE2AGENT-OPERATION") !== a.request_id ||
            hash(current) !== expected
          )
            return undefined;
          return {
            ...resource,
            revision: this.present(book, found, current).revision,
          };
        },
      });
    });
  }
}
