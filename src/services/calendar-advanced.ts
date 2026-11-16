import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import type { z } from "zod";
import type { Config } from "../core/config.js";
import { authorize, type AccessContext } from "../core/context.js";
import { References, hash } from "../core/references.js";
import { executeWrite, type OperationStore } from "../core/operations.js";
import type { HubState } from "../core/hub-state.js";
import { AppError, invalid, safeError } from "../core/errors.js";
import { schemas, interval, type Args } from "../core/schemas.js";
import {
  calendarExtraSchemas,
  eventTimes,
  type CalendarInput,
} from "../core/calendar-input.js";
import {
  readEvents,
  makeEvent,
  inspectEvent,
  editEvent,
  type EventView,
} from "../core/ical.js";
import type { CalendarAdapter, CalendarObject } from "../adapters/caldav.js";
import { CalendarService } from "./calendar.js";
import { findOpenings, eventSpan, isBusy } from "./availability.js";
import { calendarGranted, calendarAccess } from "../core/calendar-access.js";
import { schedulingInfo } from "../core/calendar-scheduling.js";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
type EventRef = { url: string; uid: string; recurrence_id?: string };
type Row = EventView & {
  event_id: string;
  calendar_id: string;
  revision?: string;
  content_truncated?: boolean;
};
export class AdvancedCalendarService extends CalendarService {
  constructor(
    private cfg: Config,
    private dav: CalendarAdapter,
    private identifiers: References,
    private ledger: OperationStore,
    private state: HubState,
    private directory?: string,
  ) {
    super(cfg, dav, identifiers, ledger);
  }
  private revision(object: CalendarObject) {
    return object.etag && !object.etag.startsWith("W/")
      ? this.identifiers.encode("calendar_revision", {
          url: object.url,
          etag: object.etag,
        })
      : undefined;
  }
  private async backup(object: CalendarObject) {
    if (!this.directory) return;
    const root = join(this.directory, "backups"),
      dir = join(root, "calendar");
    for (const path of [root, dir]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const st = await lstat(path);
      if (!st.isDirectory() || st.isSymbolicLink() || st.mode & 0o077)
        throw new AppError(
          "PERMISSION_DENIED",
          "Calendar backup directory must be private.",
        );
    }
    const id = hash([
      this.cfg.owner_id,
      this.cfg.account_id,
      object.url,
      object.etag,
    ]);
    const path = join(dir, id + ".ics");
    try {
      await writeFile(path, object.data, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const st = await lstat(path);
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        st.mode & 0o077 ||
        hash(await readFile(path, "utf8")) !== hash(object.data)
      )
        throw new AppError(
          "BACKUP_CONFLICT",
          "The original calendar content could not be safely backed up.",
        );
    }
  }
  private async scheduling(
    ctx: AccessContext,
    object: CalendarObject,
    uid: string,
  ) {
    const known = [
      this.cfg.apple_account,
      this.cfg.caldav_username,
      this.cfg.sender_address,
      this.cfg.imap_username,
    ];
    const details = inspectEvent(object.data, uid, this.cfg.default_timezone);
    if (!details.has_attendees) return schedulingInfo(object.data, uid, known);
    let discovered: string[] = [];
    try {
      discovered = (await this.dav.userAddresses?.(ctx)) ?? [];
    } catch {
      ctx.signal.throwIfAborted();
    }
    return schedulingInfo(
      object.data,
      uid,
      [...known, ...discovered],
      discovered.length > 0,
    );
  }
  private async collect(
    ctx: AccessContext,
    from: Date,
    to: Date,
    ids?: string[],
  ) {
    authorize(ctx, this.cfg, "calendar:read");
    const all = await this.dav.list(ctx),
      urls = ids?.map((id) => this.identifiers.decode<string>("calendar", id));
    const selected = urls ? all.filter((c) => urls.includes(c.url)) : all;
    if (urls?.some((url) => !selected.some((c) => c.url === url)))
      throw new AppError(
        "NOT_FOUND",
        "One requested calendar is no longer available.",
      );
    const rows: Row[] = [],
      warnings: string[] = [];
    let complete = true;
    for (const cal of selected) {
      ctx.signal.throwIfAborted();
      try {
        const objects = await this.dav.objects(ctx, cal, from, to);
        for (const object of objects) {
          try {
            const parsed = readEvents(
              object.data,
              from,
              to,
              this.cfg.default_timezone,
              [this.cfg.apple_account, this.cfg.sender_address],
            );
            complete &&=
              !parsed.truncated &&
              !parsed.warnings.some((w) => /partial|could not/i.test(w));
            warnings.push(...parsed.warnings);
            for (const e of parsed.events)
              rows.push({
                ...e,
                title: e.title.slice(0, 500),
                notes: e.notes?.slice(0, 20000),
                location: e.location?.slice(0, 1000),
                content_truncated:
                  e.title.length > 500 ||
                  (e.notes?.length ?? 0) > 20000 ||
                  (e.location?.length ?? 0) > 1000,
                event_id: this.identifiers.encode("event", {
                  url: object.url,
                  uid: e.uid,
                  recurrence_id: e.recurrence_id,
                }),
                calendar_id: this.identifiers.encode("calendar", cal.url),
                revision: this.revision(object),
              });
          } catch {
            complete = false;
            warnings.push(
              "One calendar object could not be parsed; results are partial.",
            );
          }
          if (rows.length >= 5000) {
            complete = false;
            warnings.push("The 5000-instance processing limit was reached.");
            break;
          }
        }
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        complete = false;
        warnings.push(
          `One calendar could not be queried (${safeError(e).code}).`,
        );
      }
      if (rows.length >= 5000) break;
    }
    const events = [
      ...new Map(rows.map((e) => [e.event_id + ":" + e.start, e])).values(),
    ].sort(
      (a, b) =>
        a.start.localeCompare(b.start) || a.event_id.localeCompare(b.event_id),
    );
    return {
      events,
      complete,
      warnings: [...new Set(warnings)],
      checked_calendar_ids: selected.map((c) =>
        this.identifiers.encode("calendar", c.url),
      ),
    };
  }
  override async events(
    ctx: AccessContext,
    raw: Args<"calendar_events">,
  ): Promise<any> {
    const input = schemas.calendar_events.parse(raw),
      range = interval(input.from, input.to);
    const result = await this.collect(
      ctx,
      range.from,
      range.to,
      input.calendar_id ? [input.calendar_id] : undefined,
    );
    const rows = result.events.filter(
      (e) =>
        !input.query ||
        [e.title, e.location, e.notes].some((v) =>
          String(v ?? "")
            .toLocaleLowerCase()
            .includes(input.query!.toLocaleLowerCase()),
        ),
    );
    const { cursor, limit, ...query } = input,
      page = this.identifiers.page(rows, query, limit, cursor);
    const queryComplete =
      !input.query || !result.events.some((e) => e.content_truncated);
    return {
      events: page.items,
      next_cursor: page.next_cursor,
      complete: result.complete && !page.next_cursor && queryComplete,
      truncated: !result.complete || !queryComplete,
      warnings: [
        ...result.warnings,
        ...(!queryComplete
          ? ["Some event text was truncated; keyword results may be partial."]
          : []),
      ],
      content_is_untrusted: true,
    };
  }
  private async resource(ctx: AccessContext, eventId: string) {
    const ref = this.identifiers.decode<EventRef>("event", eventId);
    if (!ref?.uid || typeof ref.url !== "string")
      throw new AppError("STALE_REFERENCE", "Invalid event reference.");
    const calendars = await this.dav.list(ctx);
    const cal = calendars.find((c) =>
      ref.url.startsWith(c.url.endsWith("/") ? c.url : c.url + "/"),
    );
    if (!cal)
      throw new AppError("NOT_FOUND", "The calendar is no longer available.");
    const object = await this.dav.get(ctx, ref.url);
    if (!object) throw new AppError("NOT_FOUND", "Event no longer exists.");
    return { ref, cal, object };
  }
  async get(
    ctx: AccessContext,
    raw: z.infer<typeof calendarExtraSchemas.calendar_get>,
  ) {
    authorize(ctx, this.cfg, "calendar:read");
    const input = calendarExtraSchemas.calendar_get.parse(raw);
    const { ref, cal, object } = await this.resource(ctx, input.event_id),
      details = inspectEvent(object.data, ref.uid, this.cfg.default_timezone);
    let instance: EventView | undefined;
    const rid = input.recurrence_id ?? ref.recurrence_id;
    if (input.scope === "occurrence" && !rid)
      invalid("A recurrence_id is required for an occurrence.");
    if (input.scope === "occurrence" && rid) {
      const d = rid.endsWith("Z")
        ? Temporal.Instant.from(rid).epochMilliseconds
        : rid.length === 10
          ? Temporal.PlainDate.from(rid).toZonedDateTime(details.input.timezone)
              .epochMilliseconds
          : Temporal.PlainDateTime.from(rid).toZonedDateTime(
              details.input.timezone,
            ).epochMilliseconds;
      instance = readEvents(
        object.data,
        new Date(d - 86400000),
        new Date(d + 93 * 86400000),
        this.cfg.default_timezone,
      ).events.find((e) => e.recurrence_id === rid);
      if (!instance)
        throw new AppError(
          "NOT_FOUND",
          "The requested occurrence is unavailable.",
        );
    }
    const scheduling = await this.scheduling(ctx, object, ref.uid);
    const access = calendarAccess(this.cfg, this.identifiers, ctx, cal);
    const granted = access.write_authorized && !!this.revision(object);
    const editableFields = scheduling.editable_fields.filter(
      (k) =>
        (details.supported_recurrence ||
          ![
            "start",
            "end",
            "all_day",
            "start_date",
            "end_date",
            "timezone",
            "recurrence",
          ].includes(k)) &&
        (!details.input.all_day || k !== "alarms_minutes_before"),
    );
    return {
      event: {
        ...details.input,
        ...instance,
        event_id: input.event_id,
        calendar_id: this.identifiers.encode("calendar", cal.url),
        revision: this.revision(object),
        recurring: details.recurring,
        raw_recurrence: details.raw_recurrence,
        overridden_instances: details.overridden_instances,
        has_attendees: details.has_attendees,
        ...access,
        scheduling_role: scheduling.role,
        editable_fields:
          granted && ctx.capabilities.has("calendar:update")
            ? editableFields
            : [],
        editable:
          granted &&
          ctx.capabilities.has("calendar:update") &&
          editableFields.length > 0,
        deletable:
          granted &&
          ctx.capabilities.has("calendar:delete") &&
          scheduling.single_uid_resource &&
          scheduling.can_delete_without_scheduling &&
          (!details.has_attendees || this.dav.supportsSilentDelete === true),
        edit_restriction:
          scheduling.role === "organizer"
            ? "participant_notification_authorization_required"
            : ["attendee", "external_copy"].includes(scheduling.role)
              ? "organizer_controls_title_time_location_and_notes"
              : scheduling.role === "unknown"
                ? "scheduling_identity_unverified"
                : null,
      },
      content_is_untrusted: true,
    };
  }
  async freeTime(
    ctx: AccessContext,
    raw: z.infer<typeof calendarExtraSchemas.calendar_find_free_time>,
  ) {
    authorize(ctx, this.cfg, "calendar:read");
    const input = calendarExtraSchemas.calendar_find_free_time.parse(raw);
    const from = Date.parse(input.from),
      to = Date.parse(input.to);
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to <= from ||
      to - from > 31 * 86400000
    )
      invalid("Availability range must be positive and at most 31 days.");
    const ids = input.calendar_ids ?? this.cfg.hub?.availability_calendar_ids;
    const result = await this.collect(
      ctx,
      new Date(from - (input.buffer_after_minutes ?? 0) * 60000),
      new Date(to + (input.buffer_before_minutes ?? 0) * 60000),
      ids,
    );
    return {
      ...(result.complete
        ? findOpenings(result.events, input)
        : { slots: [], more_available: false, defaults_applied: [] }),
      complete: result.complete,
      warnings: result.warnings,
      calendar_ids: result.checked_calendar_ids,
      timezone: input.timezone,
      checked_at: new Date().toISOString(),
      checked_from: input.from,
      checked_to: input.to,
    };
  }
  private async conflictsRaw(
    ctx: AccessContext,
    raw: string,
    uid: string,
    options: {
      ids?: string[];
      exclude?: EventRef;
      scope?: string;
      rid?: string;
      before?: number;
      after?: number;
    },
  ) {
    const details = inspectEvent(
        raw,
        uid,
        this.cfg.default_timezone,
        options.rid,
      ),
      before = (options.before ?? 0) * 60000,
      after = (options.after ?? 0) * 60000;
    const from = details.recurring
      ? Math.max(details.start.valueOf(), Date.now())
      : details.start.valueOf();
    const to = details.recurring ? from + 90 * 86400000 : details.end.valueOf();
    const candidates = readEvents(
      raw,
      new Date(from),
      new Date(to),
      details.input.timezone,
    ).events.filter((e) => !options.rid || e.recurrence_id === options.rid);
    const result = await this.collect(
      ctx,
      new Date(from - after),
      new Date(to + before),
      options.ids ?? this.cfg.hub?.availability_calendar_ids,
    );
    const existing = result.events.filter((e) => {
      if (!options.exclude) return true;
      const ref = this.identifiers.decode<EventRef>("event", e.event_id);
      return (
        ref.url !== options.exclude.url ||
        (options.scope === "occurrence" &&
          e.recurrence_id !== (options.rid ?? options.exclude.recurrence_id))
      );
    });
    const conflicts: unknown[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      if (!isBusy(c)) continue;
      const span = eventSpan(c);
      for (const e of [...existing, ...candidates.slice(0, i)]) {
        if (!isBusy(e)) continue;
        const b = eventSpan(e),
          a = Math.max(span.start, b.start - before),
          z = Math.min(span.end, b.end + after);
        if (a < z)
          conflicts.push({
            candidate_start: c.start,
            event: e,
            overlap_start: new Date(a).toISOString(),
            overlap_end: new Date(z).toISOString(),
          });
        if (conflicts.length >= 100) break;
      }
      if (conflicts.length >= 100) break;
    }
    const parsed = readEvents(
      raw,
      new Date(from),
      new Date(to),
      details.input.timezone,
    );
    const complete =
      result.complete &&
      !parsed.truncated &&
      !parsed.warnings.some((w) => /partial|could not/i.test(w)) &&
      conflicts.length < 100;
    return {
      conflicts,
      complete,
      warnings: [...result.warnings, ...parsed.warnings],
      checked_at: new Date().toISOString(),
      checked_from: new Date(from).toISOString(),
      checked_to: new Date(to).toISOString(),
      checked_calendar_ids: result.checked_calendar_ids,
      coverage: details.recurring ? "window" : "entire_event",
      skipped_past: details.recurring && details.start.valueOf() < from,
    };
  }
  async checkConflicts(
    ctx: AccessContext,
    raw: z.infer<typeof calendarExtraSchemas.calendar_check_conflicts>,
  ) {
    authorize(ctx, this.cfg, "calendar:read");
    const input = calendarExtraSchemas.calendar_check_conflicts.parse(raw),
      times = eventTimes(input);
    const target = input.event_id
      ? (await this.resource(ctx, input.event_id)).ref
      : undefined;
    const exclude = target
      ? {
          ...target,
          recurrence_id: input.recurrence_id ?? target.recurrence_id,
        }
      : undefined;
    if (exclude && !input.scope)
      invalid(
        "An exclusion requires an explicit event/occurrence/series scope.",
      );
    if (exclude && input.scope === "occurrence" && !exclude.recurrence_id)
      invalid("A recurrence_id is required for an occurrence exclusion.");
    return this.conflictsRaw(
      ctx,
      makeEvent(input, "candidate", times.start, times.end),
      "candidate",
      {
        ids: input.calendar_ids,
        exclude,
        scope: input.scope,
        rid: undefined,
        before: input.buffer_before_minutes,
        after: input.buffer_after_minutes,
      },
    );
  }
  private enforceCheck(
    result: Awaited<ReturnType<AdvancedCalendarService["conflictsRaw"]>>,
    policy?: string,
  ) {
    if (!result.complete)
      throw new AppError(
        "DATA_INCOMPLETE",
        "Cannot verify this time against all requested calendars.",
        "Resolve partial data before creating or moving this event.",
        false,
        "failed_before_write",
      );
    if (result.conflicts.length && policy !== "allow")
      throw new AppError(
        "SCHEDULE_CONFLICT",
        "The requested time overlaps an existing event.",
        "Use calendar_check_conflicts to inspect it; only allow overlap on explicit user instruction.",
        false,
        "failed_before_write",
      );
  }
  override async create(
    ctx: AccessContext,
    raw: Args<"calendar_create">,
  ): Promise<any> {
    authorize(ctx, this.cfg, "calendar:create");
    const input = schemas.calendar_create.parse(raw),
      times = eventTimes(input);
    const calendarId = input.calendar_id ?? this.cfg.default_calendar_id;
    if (!calendarId)
      throw new AppError(
        "PERMISSION_DENIED",
        "Select a locally allowed writable calendar.",
      );
    const calUrl = this.identifiers.decode<string>("calendar", calendarId),
      uid = `a2a-${hash([this.cfg.owner_id, this.cfg.account_id, input.request_id])}@apple2agent.local`;
    this.writable(calUrl, true);
    const publicCalendarId = this.identifiers.encode("calendar", calUrl);
    const url = new URL(
      `${encodeURIComponent(uid)}.ics`,
      calUrl.endsWith("/") ? calUrl : calUrl + "/",
    ).toString();
    const generated = makeEvent(input, uid, times.start, times.end),
      { request_id, ...payload } = input;
    let pre:
      Awaited<ReturnType<AdvancedCalendarService["conflictsRaw"]>> | undefined;
    const result = await this.state.locked(ctx, "calendar-write", () =>
      executeWrite(
        this.ledger,
        ctx,
        "calendar_create",
        request_id,
        { ...payload, calendar_id: calendarId },
        {
          prepare: async () => {
            const cal = (await this.dav.list(ctx)).find(
              (c) => c.url === calUrl,
            );
            if (cal?.writable !== true)
              throw new AppError(
                "PERMISSION_DENIED",
                "Calendar is not confirmed writable.",
              );
            pre = await this.conflictsRaw(ctx, generated, uid, {});
            this.enforceCheck(pre, input.conflict_policy);
          },
          write: async () => this.dav.put(ctx, url, generated),
          verify: async () => {
            const found = await this.dav.get(ctx, url);
            if (!found) return undefined;
            const actual = inspectEvent(found.data, uid, input.timezone),
              expected = inspectEvent(generated, uid, input.timezone);
            if (hash(actual.input) !== hash(expected.input))
              throw new AppError(
                "REQUEST_CONFLICT",
                "Stored event differs from its request.",
              );
            return {
              event_id: this.identifiers.encode("event", { url, uid }),
              uid,
              calendar_id: publicCalendarId,
              revision: this.revision(found),
              ...actual.input,
            };
          },
        },
      ),
    );
    let post: unknown;
    if (result.verified) {
      try {
        post = await this.conflictsRaw(ctx, generated, uid, {
          exclude: { url, uid },
          scope: "series",
        });
      } catch {
        post = {
          complete: false,
          warnings: ["Post-write conflict check could not finish."],
        };
      }
    }
    return {
      ...result,
      request_id,
      calendar_id: publicCalendarId,
      conflict_check: pre,
      post_write_conflict_check: post,
    };
  }
  private writable(calUrl: string, writable: boolean | null) {
    if (
      writable !== true ||
      !calendarGranted(this.cfg, this.identifiers, calUrl)
    )
      throw new AppError(
        "PERMISSION_DENIED",
        "Event is outside locally approved writable calendars.",
      );
  }
  async update(
    ctx: AccessContext,
    raw: z.infer<typeof calendarExtraSchemas.calendar_update>,
  ) {
    return this.mutate(
      ctx,
      calendarExtraSchemas.calendar_update.parse(raw),
      false,
    );
  }
  async delete(
    ctx: AccessContext,
    raw: z.infer<typeof calendarExtraSchemas.calendar_delete>,
  ) {
    return this.mutate(
      ctx,
      calendarExtraSchemas.calendar_delete.parse(raw),
      true,
    );
  }
  private async mutate(
    ctx: AccessContext,
    input:
      | z.infer<typeof calendarExtraSchemas.calendar_update>
      | z.infer<typeof calendarExtraSchemas.calendar_delete>,
    remove: boolean,
  ) {
    authorize(ctx, this.cfg, remove ? "calendar:delete" : "calendar:update");
    const ref = this.identifiers.decode<EventRef>("event", input.event_id),
      scope = input.scope ?? "event",
      rid = input.recurrence_id ?? ref.recurrence_id;
    const expected = this.identifiers.decode<{ url: string; etag: string }>(
      "calendar_revision",
      input.expected_revision,
    );
    if (
      expected.url !== ref.url ||
      !expected.etag ||
      expected.etag.startsWith("W/")
    )
      throw new AppError(
        "STALE_REVISION",
        "Revision belongs to another event or cannot condition a write.",
      );
    if (
      this.cfg.calendar_write_scope !== "all_writable" &&
      !this.cfg.writable_calendar_ids.some((id) => {
        const url = this.identifiers.decode<string>("calendar", id);
        return ref.url.startsWith(url.endsWith("/") ? url : url + "/");
      })
    )
      throw new AppError(
        "PERMISSION_DENIED",
        "This calendar is outside the locally selected write scope.",
      );
    const proofKey = `calendar-proof:${hash([ctx.owner_id, ctx.account_id, input.request_id, remove])}`;
    let edited: string | undefined;
    let pre: unknown;
    const receipt = { event_id: input.event_id, scope, recurrence_id: rid };
    const result = await this.state.locked(ctx, "calendar-write", () =>
      this.state.write(
        ctx,
        remove ? "calendar_delete" : "calendar_update",
        input.request_id,
        input,
        {
          verification_scope: "server",
          prepare: async () => {
            const { object, cal } = await this.resource(ctx, input.event_id);
            this.writable(cal.url, cal.writable);
            if (!object.etag || object.etag !== expected.etag)
              throw new AppError(
                "STALE_REVISION",
                "The event changed after it was read.",
                "Read it again before deciding what to change.",
              );
            const details = inspectEvent(
              object.data,
              ref.uid,
              this.cfg.default_timezone,
            );
            const scheduling = await this.scheduling(ctx, object, ref.uid);
            if (remove && scope !== "occurrence") {
              if (details.recurring ? scope !== "series" : scope !== "event")
                invalid(
                  "Choose the exact event or entire recurring series scope.",
                );
              if (!scheduling.single_uid_resource)
                throw new AppError(
                  "UNSUPPORTED_EVENT",
                  "Deleting this object would affect another event UID.",
                );
              if (!scheduling.can_delete_without_scheduling)
                throw new AppError(
                  "PROVIDER_UNSUPPORTED",
                  "This deletion requires scheduling identity verification or participant notification authorization.",
                );
              if (
                details.has_attendees &&
                this.dav.supportsSilentDelete !== true
              )
                throw new AppError(
                  "PROVIDER_UNSUPPORTED",
                  "This backend cannot suppress invitation deletion replies.",
                );
            } else {
              if (
                details.has_attendees &&
                (remove ||
                  !("patch" in input) ||
                  Object.keys(input.patch).some(
                    (k) => !scheduling.editable_fields.includes(k),
                  ))
              )
                throw new AppError(
                  "PROVIDER_UNSUPPORTED",
                  "Only the returned editable_fields may be changed without scheduling replies; organizer-controlled invitation content requires organizer permission.",
                );
              edited = editEvent(
                object.data,
                ref.uid,
                this.cfg.default_timezone,
                {
                  scope,
                  recurrence_id: rid,
                  patch: "patch" in input ? input.patch : undefined,
                  remove,
                  request_id: input.request_id,
                  allow_attendee_local_changes: [
                    "attendee",
                    "external_copy",
                  ].includes(scheduling.role),
                  allow_personal_scheduling_changes:
                    scheduling.role === "personal",
                },
              );
            }
            if (
              !remove &&
              "patch" in input &&
              [
                "start",
                "end",
                "start_date",
                "end_date",
                "timezone",
                "all_day",
                "recurrence",
                "transparent",
              ].some((k) => Object.hasOwn(input.patch, k))
            ) {
              const checked = await this.conflictsRaw(ctx, edited!, ref.uid, {
                exclude: ref,
                scope,
                rid: scope === "occurrence" ? rid : undefined,
              });
              this.enforceCheck(checked, input.conflict_policy);
              pre = checked;
            }
            if (
              (remove && scope !== "occurrence" && !this.dav.remove) ||
              ((!remove || scope === "occurrence") && !this.dav.update)
            )
              throw new AppError(
                "UNSUPPORTED_OPERATION",
                "The backend lacks conditional mutation support.",
              );
            await this.backup(object);
          },
          write: async () => {
            if (edited)
              this.state.put(
                proofKey,
                hash(
                  inspectEvent(
                    edited,
                    ref.uid,
                    this.cfg.default_timezone,
                    scope === "occurrence" ? rid : undefined,
                  ).input,
                ),
              );
            if (remove && scope !== "occurrence")
              await this.dav.remove!(ctx, ref.url, expected.etag);
            else await this.dav.update!(ctx, ref.url, edited!, expected.etag);
            return receipt;
          },
          verify: async () => {
            const found = await this.dav.get(ctx, ref.url);
            if (remove && scope !== "occurrence")
              return found ? undefined : { ...receipt, deleted: true };
            if (!found) return undefined;
            const root = new ICAL.Component(ICAL.parse(found.data)),
              target = root
                .getAllSubcomponents("vevent")
                .find(
                  (c) =>
                    String(c.getFirstPropertyValue("uid")) === ref.uid &&
                    (scope === "occurrence"
                      ? String(c.getFirstPropertyValue("recurrence-id")) === rid
                      : !c.hasProperty("recurrence-id")),
                );
            if (
              !target ||
              target.getFirstPropertyValue("x-apple2agent-operation") !==
                input.request_id
            )
              return undefined;
            if (
              remove &&
              target.getFirstPropertyValue("status") !== "CANCELLED"
            )
              return undefined;
            const proof = this.state.get<string>(proofKey);
            if (
              !proof ||
              hash(
                inspectEvent(
                  found.data,
                  ref.uid,
                  this.cfg.default_timezone,
                  scope === "occurrence" ? rid : undefined,
                ).input,
              ) !== proof
            )
              return undefined;
            return {
              ...receipt,
              revision: this.revision(found),
              ...(remove ? { deleted: true } : {}),
            };
          },
        },
      ),
    );
    return {
      ...result,
      status: result.verified
        ? remove
          ? "deleted_verified"
          : "updated_verified"
        : result.status,
      conflict_check: pre,
    };
  }
}
