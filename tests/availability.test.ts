import { test } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";
import {
  makeEvent,
  readEvents,
  inspectEvent,
  editEvent,
} from "../src/core/ical.js";
import { eventTimes, type CalendarInput } from "../src/core/calendar-input.js";
import { findOpenings } from "../src/services/availability.js";

test("wall-clock recurrence crosses DST with current IANA VTIMEZONE data", () => {
  const input: CalendarInput = {
    title: "Weekly",
    start: "2027-03-01T15:00:00-05:00",
    end: "2027-03-01T16:00:00-05:00",
    timezone: "America/New_York",
    recurrence: { freq: "WEEKLY", count: 4 },
    alarms_minutes_before: [15],
  };
  const t = eventTimes(input),
    raw = makeEvent(input, "repeating", t.start, t.end);
  const rows = readEvents(
    raw,
    new Date("2027-03-01Z"),
    new Date("2027-04-01Z"),
    input.timezone,
  );
  assert.deepEqual(
    rows.events.map((e) => e.start),
    [
      "2027-03-01T20:00:00.000Z",
      "2027-03-08T20:00:00.000Z",
      "2027-03-15T19:00:00.000Z",
      "2027-03-22T19:00:00.000Z",
    ],
  );
  assert.equal(rows.truncated, false);
  assert.deepEqual(
    inspectEvent(raw, "repeating", input.timezone).input.alarms_minutes_before,
    [15],
  );
});
test("single occurrence edit/cancel preserves master recurrence and unrelated properties", () => {
  const input: CalendarInput = {
    title: "Weekly",
    start: "2027-03-01T15:00:00+09:00",
    end: "2027-03-01T16:00:00+09:00",
    timezone: "Asia/Tokyo",
    recurrence: { freq: "WEEKLY", count: 3 },
  };
  const t = eventTimes(input);
  let raw = makeEvent(input, "repeat", t.start, t.end);
  const c = new ICAL.Component(ICAL.parse(raw));
  c.getFirstSubcomponent("vevent")!.updatePropertyWithValue(
    "x-keep",
    "untouched",
  );
  raw = c.toString();
  const edited = editEvent(raw, "repeat", input.timezone, {
    scope: "occurrence",
    recurrence_id: "2027-03-08T15:00:00",
    patch: {
      start: "2027-03-08T17:00:00+09:00",
      end: "2027-03-08T18:00:00+09:00",
    },
    request_id: "one",
  });
  const rows = readEvents(
    edited,
    new Date("2027-03-01Z"),
    new Date("2027-04-01Z"),
    input.timezone,
  ).events;
  assert.equal(rows.length, 3);
  assert.equal(
    rows.find((e) => e.recurrence_id === "2027-03-08T15:00:00")!.start,
    "2027-03-08T08:00:00.000Z",
  );
  const parsed = new ICAL.Component(ICAL.parse(edited)),
    master = parsed
      .getAllSubcomponents("vevent")
      .find((c) => !c.hasProperty("recurrence-id"))!;
  assert.ok(master.hasProperty("rrule"));
  assert.equal(master.getFirstPropertyValue("x-keep"), "untouched");
  const cancelled = editEvent(edited, "repeat", input.timezone, {
    scope: "occurrence",
    recurrence_id: "2027-03-08T15:00:00",
    remove: true,
    request_id: "two",
  });
  assert.equal(
    readEvents(
      cancelled,
      new Date("2027-03-01Z"),
      new Date("2027-04-01Z"),
      input.timezone,
    ).events.length,
    2,
  );
});
test("all-day dates remain dates and block the correct local day; transparent intervals stay free", () => {
  const input: CalendarInput = {
    title: "Away",
    all_day: true,
    start_date: "2027-03-01",
    end_date: "2027-03-02",
    timezone: "Asia/Tokyo",
  };
  const times = eventTimes(input),
    raw = makeEvent(input, "day", times.start, times.end);
  const events = readEvents(
    raw,
    new Date("2027-02-28Z"),
    new Date("2027-03-04Z"),
    input.timezone,
  ).events;
  assert.equal(events[0]!.start, "2027-03-01");
  const options = {
    from: "2027-03-01T00:00:00+09:00",
    to: "2027-03-03T00:00:00+09:00",
    timezone: input.timezone,
    duration_minutes: 30,
    limit: 5,
  };
  const busy = findOpenings(events, options);
  assert.equal(busy.slots.length, 1);
  assert.equal(busy.slots[0]!.start, "2027-03-02T00:00:00.000Z");
  assert.equal(
    findOpenings(
      events.map((e) => ({ ...e, transparent: true })),
      options,
    ).slots.length,
    2,
  );
});
test("all-day recurrence uses DATE UNTIL and stops on the inclusive final date", () => {
  const input: any = {
    title: "date series",
    all_day: true,
    start_date: "2026-11-14",
    end_date: "2026-11-15",
    timezone: "Asia/Tokyo",
    recurrence: { freq: "DAILY", until: "2026-11-16" },
  };
  const times = eventTimes(input);
  const raw = makeEvent(input, "dates", times.start, times.end);
  assert.match(raw, /UNTIL=20261116(?:;|\r|\n)/);
  const r = readEvents(
    raw,
    new Date("2026-11-13T00:00:00Z"),
    new Date("2026-11-20T00:00:00Z"),
    "Asia/Tokyo",
  );
  assert.equal(r.events.length, 3);
  assert.deepEqual(
    r.events.map((e) => e.start),
    ["2026-11-14", "2026-11-15", "2026-11-16"],
  );
});
