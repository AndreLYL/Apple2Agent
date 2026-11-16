import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import { invalid } from "./errors.js";
import { createEventSchema, eventTimes } from "./calendar-input.js";
const ref = z.string().min(1).max(16384);
const limit = z.number().int().min(1).max(100).default(20);
const timestamp = z
  .string()
  .max(80)
  .refine(
    (v) => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v),
    "Timestamp requires an explicit offset.",
  );
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    try {
      return Temporal.PlainDate.from(v).toString() === v;
    } catch {
      return false;
    }
  }, "Invalid calendar date.");
const text = z.string().max(1000);
const email = z
  .email()
  .max(320)
  .refine((v) => !/[\r\n]/.test(v));
export const schemas = {
  apple_status: z.object({}).strict(),
  calendar_list: z.object({}).strict(),
  calendar_events: z
    .object({
      from: timestamp,
      to: timestamp,
      calendar_id: ref.optional(),
      query: text.optional(),
      limit,
      cursor: ref.optional(),
    })
    .strict(),
  calendar_create: createEventSchema,
  mail_folders: z.object({}).strict(),
  mail_search: z
    .object({
      folder_id: ref.optional(),
      from: text.optional(),
      subject: text.optional(),
      text: text.optional(),
      unread: z.boolean().optional(),
      since_date: date.optional(),
      before_date: date.optional(),
      limit,
      cursor: ref.optional(),
    })
    .strict(),
  mail_read: z
    .object({
      message_ref: ref,
      max_chars: z.number().int().min(1).max(100000).default(20000),
    })
    .strict(),
  mail_draft_create: z
    .object({
      subject: z
        .string()
        .max(500)
        .refine((v) => !/[\r\n]/.test(v)),
      body_text: z.string().max(100000),
      request_id: z.uuid(),
      to: z.array(email).max(20).optional(),
      cc: z.array(email).max(20).optional(),
    })
    .strict()
    .refine(
      (v) => (v.to?.length ?? 0) + (v.cc?.length ?? 0) <= 20,
      "At most 20 recipients.",
    ),
};
export type ToolName = keyof typeof schemas;
export type Args<N extends ToolName> = z.infer<(typeof schemas)[N]>;
export function interval(from: string, to: string) {
  try {
    const start = Temporal.Instant.from(from);
    const end = Temporal.Instant.from(to);
    const span = end.epochMilliseconds - start.epochMilliseconds;
    if (span <= 0 || span > 93 * 86400000)
      invalid("Query range must be positive and at most 93 days.");
    return {
      from: new Date(start.epochMilliseconds),
      to: new Date(end.epochMilliseconds),
    };
  } catch {
    return invalid("Invalid timestamp or query range (maximum 93 days).");
  }
}
export function validateCreate(value: Args<"calendar_create">) {
  return eventTimes(value);
}
