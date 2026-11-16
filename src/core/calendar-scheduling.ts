import ICAL from "ical.js";

export const personalCalendarFields = [
  "title",
  "start",
  "end",
  "all_day",
  "start_date",
  "end_date",
  "timezone",
  "location",
  "notes",
  "recurrence",
  "alarms_minutes_before",
  "transparent",
];
export const attendeeCalendarFields = ["transparent", "alarms_minutes_before"];

export function schedulingInfo(
  raw: string,
  uid: string,
  addresses: string[],
  authoritative = false,
) {
  const all = new ICAL.Component(ICAL.parse(raw)).getAllSubcomponents("vevent");
  const items = all.filter(
    (c) => String(c.getFirstPropertyValue("uid")) === uid,
  );
  const normalize = (v: unknown) =>
    String(v ?? "")
      .replace(/^mailto:/i, "")
      .trim()
      .toLowerCase();
  const own = new Set(addresses.map(normalize).filter(Boolean));
  const organizers = items.flatMap((c) =>
    c.getAllProperties("organizer").map((p) => normalize(p.getFirstValue())),
  );
  const attendees = items.flatMap((c) =>
    c.getAllProperties("attendee").map((p) => normalize(p.getFirstValue())),
  );
  let role:
    "personal" | "attendee" | "external_copy" | "organizer" | "unknown" =
    "unknown";
  if (!organizers.length && !attendees.length) role = "personal";
  else if (organizers.length && organizers.every((a) => own.has(a)))
    role = attendees.every((a) => own.has(a)) ? "personal" : "organizer";
  else if (organizers.length && organizers.every((a) => !own.has(a))) {
    if (attendees.some((a) => own.has(a))) role = "attendee";
    else if (authoritative && own.size) role = "external_copy";
  }
  return {
    role,
    single_uid_resource:
      all.length > 0 &&
      all.every((c) => String(c.getFirstPropertyValue("uid")) === uid),
    editable_fields:
      role === "personal"
        ? personalCalendarFields
        : ["attendee", "external_copy"].includes(role)
          ? attendeeCalendarFields
          : [],
    can_delete_without_scheduling: [
      "personal",
      "attendee",
      "external_copy",
    ].includes(role),
  };
}
