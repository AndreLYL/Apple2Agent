import { Temporal } from "@js-temporal/polyfill";
import type { EventView } from "../core/ical.js";
import { invalid } from "../core/errors.js";
export interface Span {
  start: number;
  end: number;
}
export function eventSpan(event: EventView): Span {
  if (event.all_day)
    return {
      start: Temporal.PlainDate.from(event.start).toZonedDateTime(
        event.timezone,
      ).epochMilliseconds,
      end: Temporal.PlainDate.from(event.end).toZonedDateTime(event.timezone)
        .epochMilliseconds,
    };
  return { start: Date.parse(event.start), end: Date.parse(event.end) };
}
export function isBusy(event: EventView) {
  return (
    !event.transparent &&
    event.status !== "CANCELLED" &&
    event.owner_response !== "DECLINED"
  );
}
export function mergeSpans(input: Span[]): Span[] {
  const result: Span[] = [];
  for (const s of input
    .filter(
      (s) =>
        Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start,
    )
    .sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else result.push({ ...s });
  }
  return result;
}
export function findOpenings(
  events: EventView[],
  options: {
    from: string;
    to: string;
    timezone: string;
    duration_minutes: number;
    working_hours?: { weekdays: number[]; start: string; end: string }[];
    buffer_before_minutes?: number;
    buffer_after_minutes?: number;
    limit: number;
  },
) {
  const from = Temporal.Instant.from(options.from),
    to = Temporal.Instant.from(options.to);
  if (
    to.epochMilliseconds <= from.epochMilliseconds ||
    to.epochMilliseconds - from.epochMilliseconds > 31 * 86400000
  )
    invalid("Availability range must be positive and at most 31 days.");
  const before = (options.buffer_before_minutes ?? 0) * 60000,
    after = (options.buffer_after_minutes ?? 0) * 60000;
  const busy = mergeSpans(
    events.filter(isBusy).map((e) => {
      const s = eventSpan(e);
      return { start: s.start - before, end: s.end + after };
    }),
  );
  const hours = options.working_hours ?? [
    { weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
  ];
  const periods: Span[] = [];
  let day = from
    .toZonedDateTimeISO(options.timezone)
    .toPlainDate()
    .subtract({ days: 1 });
  const last = to.toZonedDateTimeISO(options.timezone).toPlainDate();
  while (Temporal.PlainDate.compare(day, last) <= 0) {
    for (const h of hours.filter((h) => h.weekdays.includes(day.dayOfWeek))) {
      const endDay = h.end <= h.start ? day.add({ days: 1 }) : day;
      const a = day.toZonedDateTime({
        timeZone: options.timezone,
        plainTime: h.start,
      }).epochMilliseconds;
      const b = endDay.toZonedDateTime({
        timeZone: options.timezone,
        plainTime: h.end,
      }).epochMilliseconds;
      periods.push({
        start: Math.max(a, from.epochMilliseconds),
        end: Math.min(b, to.epochMilliseconds),
      });
    }
    day = day.add({ days: 1 });
  }
  const free: Span[] = [];
  for (const period of mergeSpans(periods)) {
    let cursor = period.start;
    for (const b of busy) {
      if (b.end <= cursor) continue;
      if (b.start >= period.end) break;
      if (b.start > cursor)
        free.push({ start: cursor, end: Math.min(b.start, period.end) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= period.end) break;
    }
    if (cursor < period.end) free.push({ start: cursor, end: period.end });
  }
  const slots = free.filter(
    (s) => s.end - s.start >= options.duration_minutes * 60000,
  );
  return {
    slots: slots.slice(0, options.limit).map((s) => ({
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
      available_minutes: (s.end - s.start) / 60000,
    })),
    more_available: slots.length > options.limit,
    defaults_applied: options.working_hours
      ? []
      : ["working_hours:Mon-Fri 09:00-18:00"],
  };
}
