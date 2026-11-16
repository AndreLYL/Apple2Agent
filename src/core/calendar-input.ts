import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { invalid, AppError } from "./errors.js";
export const offsetTime = z
  .string()
  .max(80)
  .refine(
    (v) => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v),
    "Explicit UTC offset required.",
  );
export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    try {
      return Temporal.PlainDate.from(v).toString() === v;
    } catch {
      return false;
    }
  });
export const resourceId = z.string().min(1).max(16384);
export const recurrenceSchema = z
  .object({
    freq: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    interval: z.number().int().min(1).max(999).optional(),
    byday: z
      .array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]))
      .min(1)
      .max(7)
      .optional(),
    bymonthday: z
      .array(z.number().int().min(1).max(31))
      .min(1)
      .max(31)
      .optional(),
    count: z.number().int().min(1).max(10000).optional(),
    until: z.union([offsetTime, calendarDate]).optional(),
  })
  .strict()
  .refine((r) => !(r.count && r.until), "Use count or until, not both.");
export const eventShape = {
  title: z.string().trim().min(1).max(500),
  start: offsetTime.optional(),
  end: offsetTime.optional(),
  all_day: z.boolean().optional(),
  start_date: calendarDate.optional(),
  end_date: calendarDate.optional(),
  timezone: z.string().min(1).max(100),
  location: z.string().max(1000).optional(),
  notes: z.string().max(20000).optional(),
  recurrence: recurrenceSchema.optional(),
  alarms_minutes_before: z
    .array(z.number().int().min(0).max(10080))
    .max(5)
    .optional(),
  transparent: z.boolean().optional(),
};
export const eventInputSchema = z.object(eventShape).strict();
export type CalendarInput = z.infer<typeof eventInputSchema>;
export function eventTimes(value: CalendarInput) {
  try {
    if (value.all_day) {
      if (value.start || value.end || !value.start_date || !value.end_date)
        invalid("All-day dates and timed fields are mutually exclusive.");
      if (value.alarms_minutes_before?.length)
        invalid("All-day time-of-day alarms are not supported yet.");
      const a = Temporal.PlainDate.from(value.start_date),
        b = Temporal.PlainDate.from(value.end_date);
      const s = a.toZonedDateTime(value.timezone),
        e = b.toZonedDateTime(value.timezone);
      if (
        s.toPlainDate().toString() !== value.start_date ||
        e.toPlainDate().toString() !== value.end_date
      )
        invalid("This calendar date does not exist in the selected timezone.");
      if (Temporal.PlainDate.compare(b, a) <= 0 || a.until(b).days > 93)
        invalid("All-day end must be exclusive and within 93 days.");
      if (value.recurrence?.until) {
        if (!calendarDate.safeParse(value.recurrence.until).success)
          invalid("All-day recurrence until must be a date.");
        if (
          Temporal.PlainDate.compare(
            Temporal.PlainDate.from(value.recurrence.until),
            a,
          ) < 0
        )
          invalid("Recurrence until precedes its start.");
      }
      return {
        start: new Date(s.epochMilliseconds),
        end: new Date(e.epochMilliseconds),
      };
    }
    if (!value.start || !value.end || value.start_date || value.end_date)
      invalid(
        "Timed events require start/end offsets and no date-only fields.",
      );
    const s = Temporal.ZonedDateTime.from(`${value.start}[${value.timezone}]`, {
      offset: "reject",
      disambiguation: "reject",
    });
    const e = Temporal.ZonedDateTime.from(`${value.end}[${value.timezone}]`, {
      offset: "reject",
      disambiguation: "reject",
    });
    if (
      e.epochMilliseconds <= s.epochMilliseconds ||
      e.epochMilliseconds - s.epochMilliseconds > 93 * 86400000
    )
      invalid("Event duration must be positive and at most 93 days.");
    if (
      value.recurrence?.until &&
      Temporal.Instant.compare(
        Temporal.Instant.from(value.recurrence.until),
        s.toInstant(),
      ) < 0
    )
      invalid("Recurrence until precedes its start.");
    return {
      start: new Date(s.epochMilliseconds),
      end: new Date(e.epochMilliseconds),
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    return invalid("Invalid or ambiguous date/time, offset or timezone.");
  }
}
export const createEventSchema = z
  .object({
    ...eventShape,
    request_id: z.uuid(),
    calendar_id: resourceId.optional(),
    conflict_policy: z.enum(["reject", "allow"]).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      eventTimes(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid event time block." });
    }
  });
export const eventPatchSchema = z
  .object({
    ...eventShape,
    title: eventShape.title.optional(),
    timezone: eventShape.timezone.optional(),
    location: z.string().max(1000).nullable().optional(),
    notes: z.string().max(20000).nullable().optional(),
    recurrence: recurrenceSchema.nullable().optional(),
  })
  .strict();
export const calendarExtraSchemas = {
  calendar_get: z
    .object({
      event_id: resourceId,
      scope: z.enum(["event", "occurrence", "series"]).optional(),
      recurrence_id: z.string().max(100).optional(),
    })
    .strict(),
  calendar_update: z
    .object({
      event_id: resourceId,
      expected_revision: resourceId,
      request_id: z.uuid(),
      patch: eventPatchSchema,
      scope: z.enum(["event", "occurrence", "series"]).optional(),
      recurrence_id: z.string().max(100).optional(),
      conflict_policy: z.enum(["reject", "allow"]).optional(),
    })
    .strict(),
  calendar_delete: z
    .object({
      event_id: resourceId,
      expected_revision: resourceId,
      request_id: z.uuid(),
      scope: z.enum(["event", "occurrence", "series"]).optional(),
      recurrence_id: z.string().max(100).optional(),
    })
    .strict(),
  calendar_find_free_time: z
    .object({
      from: offsetTime,
      to: offsetTime,
      timezone: z.string().max(100),
      duration_minutes: z.number().int().min(1).max(1440),
      calendar_ids: z.array(resourceId).min(1).max(100).optional(),
      working_hours: z
        .array(
          z
            .object({
              weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
              start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
              end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
            })
            .strict(),
        )
        .max(21)
        .optional(),
      buffer_before_minutes: z.number().int().min(0).max(240).optional(),
      buffer_after_minutes: z.number().int().min(0).max(240).optional(),
      limit: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
  calendar_check_conflicts: z
    .object({
      ...eventShape,
      calendar_ids: z.array(resourceId).min(1).max(100).optional(),
      event_id: resourceId.optional(),
      scope: z.enum(["event", "occurrence", "series"]).optional(),
      recurrence_id: z.string().max(100).optional(),
      buffer_before_minutes: z.number().int().min(0).max(240).optional(),
      buffer_after_minutes: z.number().int().min(0).max(240).optional(),
    })
    .strict(),
};
