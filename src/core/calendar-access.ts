import type { Config } from "./config.js";
import type { References } from "./references.js";
import type { AccessContext, Capability } from "./context.js";
import type { Calendar } from "../adapters/caldav.js";

export function calendarGranted(config: Config, refs: References, url: string) {
  return (
    config.calendar_write_scope === "all_writable" ||
    config.writable_calendar_ids.some(
      (id) => refs.decode<string>("calendar", id) === url,
    )
  );
}

export function calendarAccess(
  config: Config,
  refs: References,
  ctx: AccessContext,
  cal: Calendar,
) {
  const reason =
    cal.writable !== true
      ? cal.writable === false
        ? "server_read_only"
        : "server_permission_unknown"
      : !calendarGranted(config, refs, cal.url)
        ? "outside_selected_calendars"
        : !["calendar:create", "calendar:update", "calendar:delete"].some((c) =>
              ctx.capabilities.has(c as Capability),
            )
          ? "read_only_profile"
          : null;
  return {
    write_authorized: reason === null,
    write_access_reason: reason,
    write_scope: config.calendar_write_scope ?? "selected",
  };
}
