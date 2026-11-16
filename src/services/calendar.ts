import type { Config } from "../core/config.js";
import { authorize, type AccessContext } from "../core/context.js";
import { References, hash } from "../core/references.js";
import {
  schemas,
  interval,
  validateCreate,
  type Args,
} from "../core/schemas.js";
import type { CalendarAdapter, Calendar } from "../adapters/caldav.js";
import { readEvents, makeEvent, type EventView } from "../core/ical.js";
import { executeWrite, type OperationStore } from "../core/operations.js";
import { AppError } from "../core/errors.js";
import { calendarAccess, calendarGranted } from "../core/calendar-access.js";
export class CalendarService {
  constructor(
    private config: Config,
    private adapter: CalendarAdapter,
    private refs: References,
    private operations: OperationStore,
  ) {}
  async list(ctx: AccessContext) {
    authorize(ctx, this.config, "calendar:read");
    return {
      calendars: (await this.adapter.list(ctx)).map((c) => ({
        calendar_id: this.refs.encode("calendar", c.url),
        name: c.name,
        writable: c.writable,
        ...calendarAccess(this.config, this.refs, ctx, c),
      })),
    };
  }
  async events(ctx: AccessContext, raw: Args<"calendar_events">) {
    authorize(ctx, this.config, "calendar:read");
    const input = schemas.calendar_events.parse(raw);
    const range = interval(input.from, input.to);
    const calendars = await this.adapter.list(ctx);
    const requested = input.calendar_id
      ? this.refs.decode<string>("calendar", input.calendar_id)
      : undefined;
    const selected = requested
      ? calendars.filter((c) => c.url === requested)
      : calendars;
    if (requested && !selected.length)
      throw new AppError(
        "NOT_FOUND",
        "Calendar is no longer available.",
        "List calendars again.",
      );
    const events: (EventView & {
      event_id: string;
      calendar_id: string;
      content_truncated: boolean;
    })[] = [];
    const warnings: string[] = [];
    let truncated = false;
    for (const c of selected) {
      try {
        const objects = await this.adapter.objects(
          ctx,
          c,
          range.from,
          range.to,
        );
        for (const object of objects) {
          try {
            const parsed = readEvents(
              object.data,
              range.from,
              range.to,
              this.config.default_timezone,
            );
            warnings.push(...parsed.warnings);
            truncated ||= parsed.truncated;
            for (const event of parsed.events) {
              const clipped =
                event.title.length > 500 ||
                (event.location?.length ?? 0) > 1000 ||
                (event.notes?.length ?? 0) > 20000;
              if (clipped)
                warnings.push(
                  "Some event fields were truncated to the documented content limits.",
                );
              events.push({
                ...event,
                title: event.title.slice(0, 500),
                location: event.location?.slice(0, 1000),
                notes: event.notes?.slice(0, 20000),
                content_truncated: clipped,
                event_id: this.refs.encode("event", {
                  url: object.url,
                  uid: event.uid,
                  recurrence_id: event.recurrence_id,
                }),
                calendar_id: this.refs.encode("calendar", c.url),
              });
            }
          } catch {
            warnings.push(
              "One calendar object could not be parsed; results are partial.",
            );
          }
          if (events.length >= 5000) {
            truncated = true;
            break;
          }
        }
      } catch (e) {
        if (selected.length === 1) throw e;
        warnings.push(
          "One calendar could not be queried; results are partial.",
        );
      }
      if (events.length >= 5000) break;
    }
    const unique = [
      ...new Map(events.map((e) => [e.event_id + ":" + e.start, e])).values(),
    ]
      .filter(
        (e) =>
          !input.query ||
          [e.title, e.location, e.notes].some((s) =>
            String(s ?? "")
              .toLocaleLowerCase()
              .includes(input.query!.toLocaleLowerCase()),
          ),
      )
      .sort(
        (a, b) =>
          a.start.localeCompare(b.start) ||
          a.event_id.localeCompare(b.event_id),
      );
    const { cursor, limit, ...query } = input;
    const page = this.refs.page(unique, query, limit, cursor);
    return {
      events: page.items,
      next_cursor: page.next_cursor,
      truncated,
      warnings: [...new Set(warnings)],
      content_is_untrusted: true,
    };
  }
  async create(ctx: AccessContext, raw: Args<"calendar_create">) {
    authorize(ctx, this.config, "calendar:create");
    const input = schemas.calendar_create.parse(raw);
    const times = validateCreate(input);
    const calendarID = input.calendar_id ?? this.config.default_calendar_id;
    if (
      !calendarID ||
      !calendarGranted(
        this.config,
        this.refs,
        this.refs.decode<string>("calendar", calendarID),
      )
    )
      throw new AppError(
        "PERMISSION_DENIED",
        "Choose a locally configured writable calendar.",
        "Run apple2agent select-calendar.",
      );
    const calendarURL = this.refs.decode<string>("calendar", calendarID);
    const uid = `a2a-${hash([this.config.owner_id, this.config.account_id, input.request_id])}@apple2agent.local`;
    const url = new URL(
      `${encodeURIComponent(uid)}.ics`,
      calendarURL.endsWith("/") ? calendarURL : calendarURL + "/",
    ).toString();
    const { request_id, ...payload } = input;
    let target: Calendar | undefined;
    const result = await executeWrite(
      this.operations,
      ctx,
      "calendar_create",
      request_id,
      { ...payload, calendar_id: calendarID },
      {
        prepare: async () => {
          target = (await this.adapter.list(ctx)).find(
            (c) => c.url === calendarURL,
          );
          if (!target || target.writable !== true)
            throw new AppError(
              "PERMISSION_DENIED",
              "The selected calendar is not confirmed writable.",
              "Select another calendar or run doctor.",
            );
        },
        write: async () =>
          this.adapter.put(
            ctx,
            url,
            makeEvent(input, uid, times.start, times.end),
          ),
        verify: async () => {
          const found = await this.adapter.get(ctx, url);
          if (!found) return undefined;
          const event = readEvents(
            found.data,
            new Date(times.start.getTime() - 1),
            new Date(times.end.getTime() + 1),
            input.timezone,
          ).events.find((e) => e.uid === uid);
          if (
            !event ||
            event.title !== input.title ||
            event.start !== times.start.toISOString() ||
            event.end !== times.end.toISOString() ||
            (event.notes ?? "") !== (input.notes ?? "") ||
            (event.location ?? "") !== (input.location ?? "")
          )
            throw new AppError(
              "REQUEST_CONFLICT",
              "Saved event does not match the original input.",
              "Inspect it manually; no replacement will be written.",
            );
          return {
            ...event,
            event_id: this.refs.encode("event", { url, uid }),
            calendar_id: calendarID,
          };
        },
      },
    );
    return { ...result, request_id, calendar_id: calendarID };
  }
}
