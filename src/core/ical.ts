import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import { AppError } from "./errors.js";
import { eventTimes, type CalendarInput } from "./calendar-input.js";
export interface EventView {
  uid: string;
  recurrence_id?: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  timezone: string;
  location?: string;
  notes?: string;
  transparent?: boolean;
  status?: string;
  owner_response?: string;
  has_attendees?: boolean;
}
function timeJS(
  t: ICAL.Time,
  fallback: string,
  zones: Map<string, ICAL.Timezone>,
): Date {
  if (t.zone.tzid === "UTC") return t.toJSDate();
  const tz = t.zone.tzid === "floating" ? fallback : t.zone.tzid;
  const custom = zones.get(tz);
  if (custom) {
    const clone = t.clone();
    clone.zone = custom;
    return clone.toJSDate();
  }
  const zoned = Temporal.ZonedDateTime.from({
    timeZone: tz,
    year: t.year,
    month: t.month,
    day: t.day,
    hour: t.hour,
    minute: t.minute,
    second: t.second,
  });
  return new Date(zoned.epochMilliseconds);
}
export function readEvents(
  ics: string,
  from: Date,
  to: Date,
  fallbackTimezone: string,
  ownerAddresses: string[] = [],
) {
  const root = new ICAL.Component(ICAL.parse(ics));
  const zones = new Map<string, ICAL.Timezone>();
  for (const component of root.getAllSubcomponents("vtimezone")) {
    const tzid = String(component.getFirstPropertyValue("tzid"));
    zones.set(tzid, new ICAL.Timezone({ component, tzid }));
  }
  const components = root.getAllSubcomponents("vevent");
  if (components.length > 2000)
    throw new AppError(
      "CONTENT_TOO_LARGE",
      "Too many event components.",
      "Narrow the query window.",
    );
  const masters = components.filter((c) => !c.hasProperty("recurrence-id"));
  const events: EventView[] = [];
  const warnings: string[] = [];
  let truncated = false;
  function add(
    event: ICAL.Event,
    start: ICAL.Time,
    end: ICAL.Time,
    recurrenceId?: string,
  ) {
    if (event.component.getFirstPropertyValue("status") === "CANCELLED") return;
    const tzid = String(
      event.component.getFirstProperty("dtstart")?.getParameter("tzid") ??
        (start.zone.tzid !== "floating" ? start.zone.tzid : fallbackTimezone),
    );
    if (
      start.zone.tzid === "floating" &&
      !event.component.getFirstProperty("dtstart")?.getParameter("tzid") &&
      !start.isDate
    )
      warnings.push(
        "Floating event interpreted using the explicitly configured calendar/account timezone.",
      );
    const s = timeJS(start, tzid, zones),
      e = timeJS(end, tzid, zones);
    if (s < to && (e > from || (e.valueOf() === s.valueOf() && s >= from)))
      events.push({
        uid: event.uid,
        recurrence_id: recurrenceId,
        title: event.summary ?? "",
        start: start.isDate ? start.toString() : s.toISOString(),
        end: end.isDate ? end.toString() : e.toISOString(),
        all_day: start.isDate,
        timezone: String(
          event.component.getFirstPropertyValue("x-apple2agent-timezone") ??
            tzid,
        ),
        location: event.location || undefined,
        notes: event.description || undefined,
        transparent:
          event.component.getFirstPropertyValue("transp") === "TRANSPARENT",
        status: String(
          event.component.getFirstPropertyValue("status") ?? "CONFIRMED",
        ),
        owner_response: event.component
          .getAllProperties("attendee")
          .find((p) =>
            ownerAddresses
              .filter(Boolean)
              .map((a) => a.toLowerCase())
              .includes(
                String(p.getFirstValue())
                  .replace(/^mailto:/i, "")
                  .toLowerCase(),
              ),
          )
          ?.getParameter("partstat") as string | undefined,
        has_attendees:
          event.component.hasProperty("attendee") ||
          event.component.hasProperty("organizer"),
      });
  }
  for (const master of masters) {
    try {
      const event = new ICAL.Event(master);
      for (const exception of components.filter(
        (c) =>
          String(c.getFirstPropertyValue("uid")) === event.uid &&
          c.hasProperty("recurrence-id"),
      ))
        event.relateException(new ICAL.Event(exception));
      if (event.isRecurring()) {
        const iterator = event.iterator();
        let steps = 0;
        while (true) {
          if (++steps > 20000 || events.length >= 2000) {
            truncated = true;
            break;
          }
          const next = iterator.next();
          if (!next) break;
          const occurrence = event.getOccurrenceDetails(next);
          // Check end as well as start: moved exceptions can cross the window boundary.
          if (
            timeJS(
              next,
              String(
                master.getFirstProperty("dtstart")?.getParameter("tzid") ??
                  fallbackTimezone,
              ),
              zones,
            ) >= to
          )
            break;
          add(
            occurrence.item,
            occurrence.startDate,
            occurrence.endDate,
            next.toString(),
          );
        }
      } else add(event, event.startDate, event.endDate);
    } catch {
      warnings.push(
        "An event could not be interpreted safely; results are partial.",
      );
    }
  }
  // CalDAV expand may return exception instances without a master.
  for (const component of components.filter((c) =>
    c.hasProperty("recurrence-id"),
  )) {
    try {
      const e = new ICAL.Event(component);
      add(
        e,
        e.startDate,
        e.endDate,
        String(component.getFirstPropertyValue("recurrence-id")),
      );
    } catch {
      warnings.push("An expanded instance could not be parsed.");
    }
  }
  return {
    events: [
      ...new Map(
        events.map((e) => [`${e.uid}:${e.recurrence_id ?? ""}:${e.start}`, e]),
      ).values(),
    ],
    warnings: [...new Set(warnings)],
    truncated,
  };
}
export function makeEvent(
  input: CalendarInput,
  uid: string,
  start: Date,
  end: Date,
) {
  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.updatePropertyWithValue("version", "2.0");
  calendar.updatePropertyWithValue("prodid", "-//Apple2Agent//Local MVP//EN");
  const event = new ICAL.Component("vevent");
  for (const [key, value] of Object.entries({
    uid,
    summary: input.title,
    location: input.location,
    description: input.notes,
    "x-apple2agent-timezone": input.timezone,
  }))
    if (value !== undefined) event.updatePropertyWithValue(key, value);
  event.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true),
  );
  if (input.all_day) {
    event.updatePropertyWithValue(
      "dtstart",
      ICAL.Time.fromDateString(input.start_date!),
    );
    event.updatePropertyWithValue(
      "dtend",
      ICAL.Time.fromDateString(input.end_date!),
    );
  } else if (input.recurrence) {
    const year = Temporal.Instant.fromEpochMilliseconds(
      start.valueOf(),
    ).toZonedDateTimeISO(input.timezone).year;
    calendar.addSubcomponent(timezoneComponent(input.timezone, year));
    for (const [name, date] of [
      ["dtstart", start],
      ["dtend", end],
    ] as const) {
      const local = Temporal.Instant.fromEpochMilliseconds(date.valueOf())
        .toZonedDateTimeISO(input.timezone)
        .toPlainDateTime()
        .toString({ smallestUnit: "second" });
      event.updatePropertyWithValue(name, ICAL.Time.fromDateTimeString(local));
      event.getFirstProperty(name)!.setParameter("tzid", input.timezone);
    }
  } else {
    event.updatePropertyWithValue("dtstart", ICAL.Time.fromJSDate(start, true));
    event.updatePropertyWithValue("dtend", ICAL.Time.fromJSDate(end, true));
  }
  if (input.recurrence) {
    const r = input.recurrence;
    const rule: any = { freq: r.freq, interval: r.interval ?? 1 };
    if (r.count) rule.count = r.count;
    if (r.until)
      rule.until = input.all_day
        ? ICAL.Time.fromDateString(r.until)
        : ICAL.Time.fromJSDate(new Date(r.until), true);
    const parts: Record<string, unknown> = {};
    if (r.byday) parts.BYDAY = r.byday;
    if (r.bymonthday) parts.BYMONTHDAY = r.bymonthday;
    rule.parts = parts;
    event.updatePropertyWithValue("rrule", new ICAL.Recur(rule));
  }
  if (input.transparent !== undefined)
    event.updatePropertyWithValue(
      "transp",
      input.transparent ? "TRANSPARENT" : "OPAQUE",
    );
  for (const minutes of [...new Set(input.alarms_minutes_before ?? [])]) {
    const alarm = new ICAL.Component("valarm");
    alarm.updatePropertyWithValue("action", "DISPLAY");
    alarm.updatePropertyWithValue("description", input.title);
    alarm.updatePropertyWithValue(
      "trigger",
      ICAL.Duration.fromSeconds(-minutes * 60),
    );
    event.addSubcomponent(alarm);
  }
  calendar.addSubcomponent(event);
  return calendar.toString();
}

/** Generate zone transitions from this runtime's IANA/Intl data, not a stale bundled tz database. */
function timezoneComponent(tz: string, year: number) {
  const zone = new ICAL.Component("vtimezone");
  zone.updatePropertyWithValue("tzid", tz);
  let current = Temporal.ZonedDateTime.from({
    timeZone: tz,
    year: year - 1,
    month: 1,
    day: 1,
  });
  const add = (name: string, local: string, from: string, to: string) => {
    const c = new ICAL.Component(name);
    c.updatePropertyWithValue("dtstart", ICAL.Time.fromDateTimeString(local));
    c.updatePropertyWithValue("tzoffsetfrom", ICAL.UtcOffset.fromString(from));
    c.updatePropertyWithValue("tzoffsetto", ICAL.UtcOffset.fromString(to));
    zone.addSubcomponent(c);
  };
  add(
    "standard",
    current.toPlainDateTime().toString({ smallestUnit: "second" }),
    current.offset,
    current.offset,
  );
  for (let steps = 0; steps < 512; steps++) {
    const next = current.getTimeZoneTransition("next");
    if (!next || next.year > year + 100) break;
    const before = next.subtract({ nanoseconds: 1 });
    const local = Temporal.Instant.fromEpochMilliseconds(
      next.epochMilliseconds + before.offsetNanoseconds / 1e6,
    )
      .toZonedDateTimeISO("UTC")
      .toPlainDateTime()
      .toString({ smallestUnit: "second" });
    add(
      next.offsetNanoseconds > before.offsetNanoseconds
        ? "daylight"
        : "standard",
      local,
      before.offset,
      next.offset,
    );
    current = next.add({ seconds: 1 });
  }
  return zone;
}
function components(raw: string, uid: string) {
  const root = new ICAL.Component(ICAL.parse(raw));
  const items = root
    .getAllSubcomponents("vevent")
    .filter((c) => String(c.getFirstPropertyValue("uid")) === uid);
  const master = items.find((c) => !c.hasProperty("recurrence-id"));
  if (!master)
    throw new AppError(
      "UNSUPPORTED_EVENT",
      "A master event is required for this operation.",
    );
  const zones = new Map<string, ICAL.Timezone>();
  for (const c of root.getAllSubcomponents("vtimezone")) {
    const tzid = String(c.getFirstPropertyValue("tzid"));
    zones.set(tzid, new ICAL.Timezone({ component: c, tzid }));
  }
  return { root, items, master, zones };
}
export function inspectEvent(
  raw: string,
  uid: string,
  fallback: string,
  recurrenceId?: string,
) {
  const parts = components(raw, uid),
    items = parts.items,
    zones = parts.zones;
  const master = recurrenceId
    ? items.find(
        (c) =>
          String(c.getFirstPropertyValue("recurrence-id")) === recurrenceId,
      )
    : parts.master;
  if (!master)
    throw new AppError("NOT_FOUND", "The requested exception is unavailable.");
  const e = new ICAL.Event(master);
  const timezone = String(
    master.getFirstPropertyValue("x-apple2agent-timezone") ??
      master.getFirstProperty("dtstart")?.getParameter("tzid") ??
      fallback,
  );
  const utc = (t: ICAL.Time) => timeJS(t, timezone, zones);
  const start = utc(e.startDate),
    end = utc(e.endDate);
  const local = (d: Date) =>
    Temporal.Instant.fromEpochMilliseconds(d.valueOf())
      .toZonedDateTimeISO(timezone)
      .toString({ timeZoneName: "never", smallestUnit: "second" });
  const rule = master.getFirstPropertyValue("rrule") as ICAL.Recur | null;
  let recurrence: CalendarInput["recurrence"];
  let supported = true;
  if (rule) {
    const parts = rule.parts as Record<string, unknown>;
    supported =
      ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq) &&
      !Object.keys(parts).some((k) => !["BYDAY", "BYMONTHDAY"].includes(k)) &&
      !(parts.BYDAY as string[] | undefined)?.some(
        (x) => !["MO", "TU", "WE", "TH", "FR", "SA", "SU"].includes(x),
      ) &&
      !(parts.BYMONTHDAY as number[] | undefined)?.some(
        (x) => x < 1 || x > 31,
      ) &&
      (!rule.count || rule.count <= 10000);
    recurrence = {
      freq: rule.freq as NonNullable<CalendarInput["recurrence"]>["freq"],
      interval: rule.interval,
      ...(rule.count ? { count: rule.count } : {}),
      ...(rule.until
        ? {
            until: rule.until.isDate
              ? rule.until.toString()
              : utc(rule.until).toISOString(),
          }
        : {}),
      ...(parts.BYDAY ? { byday: parts.BYDAY as any } : {}),
      ...(parts.BYMONTHDAY ? { bymonthday: parts.BYMONTHDAY as number[] } : {}),
    };
  }
  const alarms = master
    .getAllSubcomponents("valarm")
    .filter((c) => c.getFirstPropertyValue("action") === "DISPLAY")
    .map((c) => c.getFirstPropertyValue("trigger"))
    .filter((x): x is ICAL.Duration => x instanceof ICAL.Duration)
    .map((d) => -d.toSeconds() / 60);
  const input: CalendarInput = {
    title: e.summary ?? "",
    timezone,
    location: e.location || undefined,
    notes: e.description || undefined,
    transparent: master.getFirstPropertyValue("transp") === "TRANSPARENT",
    ...(e.startDate.isDate
      ? {
          all_day: true,
          start_date: e.startDate.toString(),
          end_date: e.endDate.toString(),
        }
      : { start: local(start), end: local(end) }),
    ...(recurrence ? { recurrence } : {}),
    ...(alarms.length ? { alarms_minutes_before: alarms } : {}),
  };
  return {
    input,
    recurring: !!rule,
    supported_recurrence: supported,
    raw_recurrence: rule?.toString(),
    has_attendees: items.some(
      (c) => c.hasProperty("attendee") || c.hasProperty("organizer"),
    ),
    overridden_instances: items.filter((c) => c.hasProperty("recurrence-id"))
      .length,
    start,
    end,
  };
}
export function editEvent(
  raw: string,
  uid: string,
  fallback: string,
  options: {
    scope: "event" | "occurrence" | "series";
    recurrence_id?: string;
    patch?: Record<string, unknown>;
    remove?: boolean;
    request_id: string;
    allow_attendee_local_changes?: boolean;
    allow_personal_scheduling_changes?: boolean;
  },
) {
  const { root, items, master, zones } = components(raw, uid),
    details = inspectEvent(raw, uid, fallback);
  const timeFields = [
    "start",
    "end",
    "start_date",
    "end_date",
    "timezone",
    "all_day",
    "recurrence",
  ];
  const timeChange =
    options.scope === "occurrence" ||
    timeFields.some((k) => Object.hasOwn(options.patch ?? {}, k));
  if (!details.supported_recurrence && (timeChange || options.remove))
    throw new AppError(
      "UNSUPPORTED_EVENT",
      "This recurrence cannot be safely edited.",
    );
  if (
    details.has_attendees &&
    !options.allow_personal_scheduling_changes &&
    !(
      options.allow_attendee_local_changes &&
      !options.remove &&
      Object.keys(options.patch ?? {}).every((k) =>
        ["transparent", "alarms_minutes_before"].includes(k),
      )
    )
  )
    throw new AppError(
      "PERMISSION_DENIED",
      "This invitation change requires organizer permission or explicit scheduling notification support.",
    );
  if (details.recurring && options.scope === "event")
    throw new AppError(
      "INVALID_INPUT",
      "Choose occurrence or series for a repeating event.",
    );
  if (!details.recurring && options.scope !== "event")
    throw new AppError(
      "INVALID_INPUT",
      "This event is not a repeating series.",
    );
  let target = master,
    base = details.input;
  if (options.scope === "occurrence") {
    if (!options.recurrence_id)
      throw new AppError(
        "INVALID_INPUT",
        "A canonical recurrence_id is required.",
      );
    const recurrence = ICAL.Time.fromString(
      options.recurrence_id,
      master.getFirstProperty("dtstart")!,
    );
    const time = timeJS(recurrence, details.input.timezone, zones).valueOf();
    const occurrence = readEvents(
      raw,
      new Date(time - 86400000),
      new Date(time + 86400000 * 94),
      fallback,
    ).events.find((e) => e.recurrence_id === options.recurrence_id);
    if (!occurrence)
      throw new AppError(
        "NOT_FOUND",
        "The requested recurrence is not available.",
      );
    const old = items.find(
      (c) =>
        String(c.getFirstPropertyValue("recurrence-id")) ===
        options.recurrence_id,
    );
    target = old ?? new ICAL.Component(structuredClone(master.toJSON()));
    target.removeAllProperties("rrule");
    target.removeAllProperties("rdate");
    target.removeAllProperties("exdate");
    target.updatePropertyWithValue("recurrence-id", recurrence);
    const tz = master.getFirstProperty("dtstart")?.getParameter("tzid");
    if (tz && !recurrence.isDate)
      target
        .getFirstProperty("recurrence-id")!
        .setParameter("tzid", String(tz));
    if (!old) root.addSubcomponent(target);
    const asLocal = (s: string) =>
      Temporal.Instant.from(s)
        .toZonedDateTimeISO(base.timezone)
        .toString({ timeZoneName: "never", smallestUnit: "second" });
    base = {
      ...base,
      recurrence: undefined,
      ...(occurrence.all_day
        ? { start_date: occurrence.start, end_date: occurrence.end }
        : { start: asLocal(occurrence.start), end: asLocal(occurrence.end) }),
    };
  }
  if (options.remove) {
    target.updatePropertyWithValue("status", "CANCELLED");
  } else {
    const patch = options.patch ?? {};
    if (options.scope === "occurrence" && Object.hasOwn(patch, "recurrence"))
      throw new AppError(
        "INVALID_INPUT",
        "A single occurrence cannot change the series rule.",
      );
    if (
      details.overridden_instances &&
      options.scope === "series" &&
      [
        "recurrence",
        "start",
        "end",
        "start_date",
        "end_date",
        "timezone",
        "all_day",
      ].some((k) => Object.hasOwn(patch, k))
    )
      throw new AppError(
        "UNSUPPORTED_EVENT",
        "Series time changes with existing exceptions require explicit remapping.",
      );
    const merged = {
      ...base,
      ...patch,
      location:
        patch.location === null ? undefined : (patch.location ?? base.location),
      notes: patch.notes === null ? undefined : (patch.notes ?? base.notes),
      recurrence:
        patch.recurrence === null
          ? undefined
          : (patch.recurrence ?? base.recurrence),
    } as CalendarInput;
    if (patch.all_day === true) {
      delete merged.start;
      delete merged.end;
    } else if (patch.all_day === false) {
      delete merged.start_date;
      delete merged.end_date;
    }
    const times =
        timeChange || Object.hasOwn(patch, "alarms_minutes_before")
          ? eventTimes(merged)
          : { start: details.start, end: details.end },
      generated = new ICAL.Component(
        ICAL.parse(makeEvent(merged, uid, times.start, times.end)),
      );
    const replacement = generated.getFirstSubcomponent("vevent")!;
    const timeTouched =
      [
        "start",
        "end",
        "start_date",
        "end_date",
        "timezone",
        "all_day",
        "recurrence",
      ].some((k) => Object.hasOwn(patch, k)) || options.scope === "occurrence";
    const names = [
      ...Object.keys(patch)
        .map((k) => ({ title: "summary", notes: "description" })[k] ?? k)
        .filter((k) => ["summary", "description", "location"].includes(k)),
    ];
    if (Object.hasOwn(patch, "transparent")) names.push("transp");
    if (timeTouched)
      names.push(
        "dtstart",
        "dtend",
        "rrule",
        "rdate",
        "exdate",
        "x-apple2agent-timezone",
      );
    for (const name of new Set(names)) {
      target.removeAllProperties(name);
      for (const p of replacement.getAllProperties(name))
        target.addProperty(new ICAL.Property(structuredClone(p.toJSON())));
    }
    if (Object.hasOwn(patch, "alarms_minutes_before")) {
      for (const c of target.getAllSubcomponents("valarm"))
        if (c.getFirstPropertyValue("action") === "DISPLAY")
          target.removeSubcomponent(c);
      for (const c of replacement.getAllSubcomponents("valarm"))
        target.addSubcomponent(new ICAL.Component(structuredClone(c.toJSON())));
    }
    for (const c of generated.getAllSubcomponents("vtimezone")) {
      const id = c.getFirstPropertyValue("tzid");
      for (const existing of root.getAllSubcomponents("vtimezone"))
        if (existing.getFirstPropertyValue("tzid") === id)
          root.removeSubcomponent(existing);
      root.addSubcomponent(c);
    }
  }
  target.updatePropertyWithValue("x-apple2agent-operation", options.request_id);
  target.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true),
  );
  return root.toString();
}
