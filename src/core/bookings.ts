import ICAL from "ical.js";
import type { ParsedMail } from "mailparser";
import { inspectEvent } from "./ical.js";
/** Read-only extraction with evidence. A candidate is never authorization to write a calendar. */
export function extractBookings(mail: ParsedMail, fallbackTimezone: string) {
  const candidates: any[] = [],
    warnings: string[] = [];
  let visited = 0;
  function walk(value: any, path: string, depth = 0) {
    if (depth > 8 || ++visited > 1000 || candidates.length >= 20) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    const types = Array.isArray(value["@type"])
        ? value["@type"]
        : [value["@type"]],
      type = types.find(
        (t: unknown) =>
          typeof t === "string" && (/Reservation$/.test(t) || t === "Event"),
      );
    if (type) {
      const item = value.reservationFor ?? value;
      const start =
          value.checkinTime ??
          value.checkinDate ??
          item.startDate ??
          item.departureTime,
        end =
          value.checkoutTime ??
          value.checkoutDate ??
          item.endDate ??
          item.arrivalTime;
      candidates.push({
        kind: "schema_org",
        type,
        title: String(item.name ?? value.name ?? type).slice(0, 1000),
        start: typeof start === "string" ? start : undefined,
        end: typeof end === "string" ? end : undefined,
        location:
          item.location ??
          item.departureAirport ??
          item.departureStation ??
          undefined,
        reservation_id: value.reservationId ?? undefined,
        status: value.reservationStatus ?? undefined,
        evidence: { json_path: path },
        timezone_confirmed:
          typeof start === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(start),
        untrusted: true,
      });
    }
    for (const [k, v] of Object.entries(value))
      if (
        k === "@graph" ||
        k === "mainEntity" ||
        k === "about" ||
        (!type && k === "reservationFor")
      )
        walk(v, `${path}.${k}`, depth + 1);
  }
  const html = typeof mail.html === "string" ? mail.html : "";
  for (const [i, match] of [
    ...html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].entries()) {
    try {
      walk(JSON.parse(match[1]!.slice(0, 262144)), `script[${i}]`);
    } catch {
      warnings.push("A structured-data block could not be parsed.");
    }
  }
  for (const item of mail.attachments) {
    if (
      item.contentType !== "text/calendar" &&
      !item.filename?.endsWith(".ics")
    )
      continue;
    if (item.size > 4 * 1024 * 1024) {
      warnings.push("One calendar attachment exceeded 4 MiB.");
      continue;
    }
    try {
      const raw = item.content.toString("utf8"),
        root = new ICAL.Component(ICAL.parse(raw));
      for (const event of root.getAllSubcomponents("vevent")) {
        if (candidates.length >= 20) break;
        const uid = String(event.getFirstPropertyValue("uid") ?? "");
        if (!uid) continue;
        const details = inspectEvent(raw, uid, fallbackTimezone),
          time = event.getFirstPropertyValue("dtstart") as
            ICAL.Time | undefined;
        const zone = event.getFirstProperty("dtstart")?.getParameter("tzid");
        candidates.push({
          kind: "icalendar",
          event: details.input,
          source_uid: uid,
          evidence: { attachment: item.filename },
          timezone_confirmed:
            !!time?.isDate || !!zone || time?.zone?.tzid === "UTC",
          timezone_default_used:
            !time?.isDate && !zone && time?.zone?.tzid !== "UTC",
          untrusted: true,
        });
      }
    } catch {
      warnings.push("One calendar attachment could not be parsed safely.");
    }
  }
  return {
    candidates,
    warnings,
    complete: !warnings.length && candidates.length < 20 && visited <= 1000,
    calendar_created: false,
    requires_user_instruction_to_create: true,
  };
}
