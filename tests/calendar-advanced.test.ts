import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { fixture, eventInput, FakeCalendar } from "./fixtures.js";
import { HubState } from "../src/core/hub-state.js";
import { AdvancedCalendarService } from "../src/services/calendar-advanced.js";
import type { AccessContext } from "../src/core/context.js";
import { AppError } from "../src/core/errors.js";
import { CalDAVAdapter, type Calendar } from "../src/adapters/caldav.js";

class VersionedCalendar extends FakeCalendar {
  calendars?: Calendar[];
  supportsSilentDelete = false;
  removeCalls = 0;
  lostRemove = false;
  async userAddresses() {
    return ["mailto:test@example.com"];
  }
  override async list(): Promise<Calendar[]> {
    return this.calendars ?? super.list();
  }
  revision = 0;
  lostUpdate = false;
  failReads = false;
  override async get(ctx: AccessContext, url: string) {
    const value = await super.get(ctx, url);
    return value ? { ...value, etag: `"${this.revision}"` } : undefined;
  }
  override async put(ctx: AccessContext, url: string, data: string) {
    await super.put(ctx, url, data);
    this.revision++;
  }
  async update(_ctx: AccessContext, url: string, data: string, etag: string) {
    if (etag !== `"${this.revision}"`)
      throw new AppError(
        "STALE_REVISION",
        "changed",
        undefined,
        false,
        "failed_before_write",
      );
    this.data.set(url, data);
    this.revision++;
    if (this.lostUpdate) {
      this.lostUpdate = false;
      throw new Error("lost update");
    }
  }
  async remove(_ctx: AccessContext, url: string, etag: string) {
    if (etag !== `"${this.revision}"`)
      throw new AppError(
        "STALE_REVISION",
        "changed",
        undefined,
        false,
        "failed_before_write",
      );
    this.removeCalls++;
    this.data.delete(url);
    this.revision++;
    if (this.lostRemove) {
      this.lostRemove = false;
      throw new Error("lost delete response");
    }
  }
  override async objects(_ctx?: AccessContext, calendar?: Calendar) {
    if (this.failReads) throw new Error("offline");
    return (await super.objects()).filter(
      (o) => !calendar || o.url.startsWith(calendar.url),
    );
  }
}
function setup() {
  const f = fixture(),
    dav = new VersionedCalendar(),
    state = new HubState(":memory:");
  return {
    ...f,
    dav,
    state,
    service: new AdvancedCalendarService(
      f.cfg,
      dav,
      f.refs,
      f.operations,
      state,
    ),
    close() {
      state.close();
      f.operations.close();
    },
  };
}
test("conditional calendar edit/delete, stale revisions and lost update receipts", async () => {
  const f = setup();
  try {
    const made = await f.service.create(f.ctx, eventInput()),
      id = made.resource.event_id;
    const before = await f.service.get(f.ctx, { event_id: id });
    f.dav.lostUpdate = true;
    const change = {
      event_id: id,
      expected_revision: before.event.revision!,
      request_id: randomUUID(),
      patch: { title: "Updated" },
    };
    await assert.rejects(f.service.update(f.ctx, change), {
      code: "OUTCOME_UNKNOWN",
    });
    assert.equal(
      (await f.service.update(f.ctx, change)).status,
      "updated_verified",
    );
    await assert.rejects(
      f.service.update(f.ctx, {
        ...change,
        request_id: randomUUID(),
        patch: { title: "stale" },
      }),
      { code: "STALE_REVISION" },
    );
    const current = await f.service.get(f.ctx, { event_id: id });
    assert.equal(current.event.title, "Updated");
    assert.equal(
      (
        await f.service.delete(f.ctx, {
          event_id: id,
          expected_revision: current.event.revision!,
          request_id: randomUUID(),
        })
      ).status,
      "deleted_verified",
    );
    assert.equal(f.dav.data.size, 0);
  } finally {
    f.close();
  }
});
test("conflicting distinct requests serialize, touching endpoints do not conflict, incomplete data never confirms free", async () => {
  const f = setup();
  try {
    const input = eventInput();
    const outcomes = await Promise.allSettled([
      f.service.create(f.ctx, input),
      f.service.create(f.ctx, { ...input, request_id: randomUUID() }),
    ]);
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(f.dav.writes, 1);
    await f.service.create(f.ctx, {
      ...input,
      start: input.end,
      end: "2026-11-14T11:00:00+09:00",
      request_id: randomUUID(),
    });
    f.dav.failReads = true;
    const free = await f.service.freeTime(f.ctx, {
      from: "2026-11-14T00:00:00+09:00",
      to: "2026-11-15T00:00:00+09:00",
      timezone: "Asia/Tokyo",
      duration_minutes: 30,
      limit: 5,
    });
    assert.equal(free.complete, false);
    assert.deepEqual(free.slots, []);
    await assert.rejects(
      f.service.create(f.ctx, {
        ...input,
        request_id: randomUUID(),
        conflict_policy: "allow",
      }),
      { code: "DATA_INCOMPLETE" },
    );
  } finally {
    f.close();
  }
});
test("series operations require explicit scope; deleting one occurrence preserves the other dates", async () => {
  const f = setup();
  try {
    const input = {
        ...eventInput(),
        recurrence: { freq: "WEEKLY" as const, count: 3 },
      },
      made = await f.service.create(f.ctx, input);
    const id = made.resource.event_id,
      details = await f.service.get(f.ctx, { event_id: id });
    await assert.rejects(
      f.service.delete(f.ctx, {
        event_id: id,
        expected_revision: details.event.revision!,
        request_id: randomUUID(),
      }),
      { code: "INVALID_INPUT" },
    );
    const events = await f.service.events(f.ctx, {
      from: "2026-11-14T00:00:00+09:00",
      to: "2026-12-01T00:00:00+09:00",
      limit: 20,
    });
    const target = events.events[1];
    const done = await f.service.delete(f.ctx, {
      event_id: target.event_id,
      recurrence_id: target.recurrence_id,
      scope: "occurrence",
      expected_revision: details.event.revision!,
      request_id: randomUUID(),
    });
    assert.equal(done.status, "deleted_verified");
    const rows = await f.service.events(f.ctx, {
      from: "2026-11-14T00:00:00+09:00",
      to: "2026-12-01T00:00:00+09:00",
      limit: 20,
    });
    assert.equal(rows.events.length, 2);
    const raw = [...f.dav.data.values()][0]!;
    assert.ok(
      new ICAL.Component(ICAL.parse(raw))
        .getAllSubcomponents("vevent")
        .some((c) => c.hasProperty("rrule")),
    );
  } finally {
    f.close();
  }
});

const workURL = "https://caldav.icloud.com/home/work/";
function seedInvitation(
  f: ReturnType<typeof setup>,
  options: {
    organizerOwn?: boolean;
    attendeeOwn?: boolean;
    mixed?: boolean;
  } = {},
) {
  const uid = "invitation-series",
    url = "https://caldav.icloud.com/home/personal/invitation.ics";
  const raw = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTART:20261114T010000Z",
    "DTEND:20261114T020000Z",
    "RRULE:FREQ=DAILY;COUNT=3",
    "SUMMARY:Invitation",
    `ORGANIZER:mailto:${options.organizerOwn ? "test@example.com" : "external@example.com"}`,
    `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${options.attendeeOwn === false ? "somebody@example.com" : "test@example.com"}`,
    "ATTENDEE:mailto:other@example.com",
    "X-KEEP:opaque",
    "END:VEVENT",
    ...(options.mixed
      ? [
          "BEGIN:VEVENT",
          "UID:unrelated",
          "DTSTART:20261114T030000Z",
          "DTEND:20261114T040000Z",
          "SUMMARY:Unrelated",
          "END:VEVENT",
        ]
      : []),
    "END:VCALENDAR",
  ].join("\r\n");
  f.dav.data.set(url, raw);
  return { uid, url, id: f.refs.encode("event", { url, uid }) };
}

test("all-writable scope permits cross-calendar writes while keeping default, server ACL and read-only profile", async () => {
  const f = setup();
  try {
    f.dav.calendars = [
      ...(await f.dav.list()),
      { url: workURL, name: "Work", writable: true },
      { url: workURL + "unknown/", name: "Unknown", writable: null },
    ];
    const target = f.refs.encode("calendar", workURL),
      originalDefault = f.cfg.default_calendar_id;
    await assert.rejects(
      f.service.create(f.ctx, { ...eventInput(), calendar_id: target }),
      { code: "PERMISSION_DENIED" },
    );
    f.cfg.calendar_write_scope = "all_writable";
    const made = await f.service.create(f.ctx, {
      ...eventInput(),
      calendar_id: target,
      request_id: randomUUID(),
    });
    assert.equal(f.cfg.default_calendar_id, originalDefault);
    const list = await f.service.list(f.ctx);
    assert.equal(
      list.calendars.find((c) => c.name === "Work")?.write_authorized,
      true,
    );
    assert.equal(
      list.calendars.find((c) => c.name === "Read only")?.write_authorized,
      false,
    );
    assert.equal(
      list.calendars.find((c) => c.name === "Unknown")?.write_access_reason,
      "server_permission_unknown",
    );
    const before = await f.service.get(f.ctx, {
      event_id: made.resource.event_id,
    });
    const change = {
      event_id: made.resource.event_id,
      expected_revision: before.event.revision!,
      request_id: randomUUID(),
      patch: { title: "Work updated" },
    };
    assert.equal(
      (await f.service.update(f.ctx, change)).status,
      "updated_verified",
    );
    const readonly = {
      ...f.ctx,
      capabilities: new Set(["calendar:read"] as const),
    };
    await assert.rejects(f.service.update(readonly, change), {
      code: "PERMISSION_DENIED",
    });
    assert.equal(
      (await f.service.list(readonly)).calendars.some(
        (c) => c.write_authorized,
      ),
      false,
    );
    f.cfg.calendar_write_scope = "selected";
    await assert.rejects(f.service.update(f.ctx, change), {
      code: "PERMISSION_DENIED",
    });
    f.cfg.calendar_write_scope = "all_writable";
    const current = await f.service.get(f.ctx, {
      event_id: made.resource.event_id,
    });
    f.dav.calendars.find((c) => c.url === workURL)!.writable = false;
    await assert.rejects(
      f.service.update(f.ctx, {
        ...change,
        request_id: randomUUID(),
        expected_revision: current.event.revision!,
      }),
      { code: "PERMISSION_DENIED" },
    );
    assert.equal(
      [...f.dav.data.values()].some((v) => v.includes("Work updated")),
      true,
    );
  } finally {
    f.close();
  }
});

test("all-writable scope cannot create in read-only, unknown or undiscovered calendars", async () => {
  const f = setup();
  try {
    f.cfg.calendar_write_scope = "all_writable";
    f.dav.calendars = [
      ...(await f.dav.list()),
      { url: workURL, name: "Unknown", writable: null },
    ];
    for (const url of [
      "https://caldav.icloud.com/home/shared/",
      workURL,
      "https://caldav.icloud.com/home/absent/",
    ])
      await assert.rejects(
        f.service.create(f.ctx, {
          ...eventInput(),
          calendar_id: f.refs.encode("calendar", url),
          request_id: randomUUID(),
        }),
        { code: "PERMISSION_DENIED" },
      );
    assert.equal(f.dav.writes, 0);
  } finally {
    f.close();
  }
});

test("attendee local edits preserve invitation identity and deny organizer fields or single-instance declines", async () => {
  const f = setup();
  try {
    const s = seedInvitation(f);
    let before = await f.service.get(f.ctx, {
      event_id: s.id,
      scope: "series",
    });
    assert.equal(before.event.scheduling_role, "attendee");
    assert.deepEqual(before.event.editable_fields, [
      "transparent",
      "alarms_minutes_before",
    ]);
    await assert.rejects(
      f.service.update(f.ctx, {
        event_id: s.id,
        scope: "series",
        expected_revision: before.event.revision!,
        request_id: randomUUID(),
        patch: { title: "Forbidden" },
      }),
      { code: "PROVIDER_UNSUPPORTED" },
    );
    assert.equal(
      (
        await f.service.update(f.ctx, {
          event_id: s.id,
          scope: "series",
          expected_revision: before.event.revision!,
          request_id: randomUUID(),
          patch: { transparent: true, alarms_minutes_before: [10] },
        })
      ).status,
      "updated_verified",
    );
    const raw = f.dav.data.get(s.url)!;
    assert.ok(raw.includes("PARTSTAT=ACCEPTED"));
    assert.ok(raw.includes("ORGANIZER:mailto:external@example.com"));
    assert.ok(raw.includes("X-KEEP:opaque"));
    before = await f.service.get(f.ctx, { event_id: s.id, scope: "series" });
    await assert.rejects(
      f.service.delete(f.ctx, {
        event_id: s.id,
        scope: "occurrence",
        recurrence_id: "2026-11-14T01:00:00Z",
        expected_revision: before.event.revision!,
        request_id: randomUUID(),
      }),
      { code: "PROVIDER_UNSUPPORTED" },
    );
    assert.equal(f.dav.removeCalls, 0);
  } finally {
    f.close();
  }
});

test("silent invitation series deletion is conditional, backend-gated and recovers lost receipts without resubmission", async () => {
  const f = setup();
  try {
    const s = seedInvitation(f),
      before = await f.service.get(f.ctx, { event_id: s.id, scope: "series" });
    const input = {
      event_id: s.id,
      scope: "series" as const,
      expected_revision: before.event.revision!,
      request_id: randomUUID(),
    };
    await assert.rejects(f.service.delete(f.ctx, input), {
      code: "PROVIDER_UNSUPPORTED",
    });
    f.dav.supportsSilentDelete = true;
    f.dav.revision++;
    await assert.rejects(
      f.service.delete(f.ctx, { ...input, request_id: randomUUID() }),
      { code: "STALE_REVISION" },
    );
    const current = await f.service.get(f.ctx, {
      event_id: s.id,
      scope: "series",
    });
    assert.equal(current.event.deletable, true);
    const actual = {
      ...input,
      expected_revision: current.event.revision!,
      request_id: randomUUID(),
    };
    f.dav.lostRemove = true;
    await assert.rejects(f.service.delete(f.ctx, actual), {
      code: "OUTCOME_UNKNOWN",
    });
    assert.equal(
      (await f.service.delete(f.ctx, actual)).status,
      "deleted_verified",
    );
    assert.equal(f.dav.removeCalls, 1);
    assert.equal(f.dav.data.size, 0);
  } finally {
    f.close();
  }
});

test("external imported invitation copies need authoritative principal addresses; organizer notifications and mixed UIDs remain protected", async () => {
  const f = setup();
  try {
    f.dav.supportsSilentDelete = true;
    const s = seedInvitation(f, { attendeeOwn: false });
    const before = await f.service.get(f.ctx, {
      event_id: s.id,
      scope: "series",
    });
    assert.equal(before.event.scheduling_role, "external_copy");
    assert.equal(before.event.deletable, true);
    f.dav.userAddresses = async () => [];
    const unknown = await f.service.get(f.ctx, {
      event_id: s.id,
      scope: "series",
    });
    assert.equal(unknown.event.scheduling_role, "unknown");
    await assert.rejects(
      f.service.delete(f.ctx, {
        event_id: s.id,
        scope: "series",
        expected_revision: unknown.event.revision!,
        request_id: randomUUID(),
      }),
      { code: "PROVIDER_UNSUPPORTED" },
    );
    seedInvitation(f, { organizerOwn: true });
    const organized = await f.service.get(f.ctx, {
      event_id: s.id,
      scope: "series",
    });
    assert.equal(organized.event.deletable, false);
    await assert.rejects(
      f.service.delete(f.ctx, {
        event_id: s.id,
        scope: "series",
        expected_revision: organized.event.revision!,
        request_id: randomUUID(),
      }),
      { code: "PROVIDER_UNSUPPORTED" },
    );
    seedInvitation(f, { mixed: true });
    const mixed = await f.service.get(f.ctx, {
      event_id: s.id,
      scope: "series",
    });
    await assert.rejects(
      f.service.delete(f.ctx, {
        event_id: s.id,
        scope: "series",
        expected_revision: mixed.event.revision!,
        request_id: randomUUID(),
      }),
      { code: "UNSUPPORTED_EVENT" },
    );
    assert.equal(f.dav.removeCalls, 0);
  } finally {
    f.close();
  }
});

test("metadata edits preserve long legacy event duration and unsupported recurrence properties", async () => {
  const f = setup();
  try {
    const url = "https://caldav.icloud.com/home/personal/legacy.ics",
      uid = "legacy";
    f.dav.data.set(
      url,
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTART;VALUE=DATE:20230101",
        "DTEND;VALUE=DATE:20240101",
        "RRULE:FREQ=DAILY;BYHOUR=9",
        "SUMMARY:Legacy",
        "X-KEEP:original",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const id = f.refs.encode("event", { url, uid }),
      before = await f.service.get(f.ctx, { event_id: id, scope: "series" });
    assert.equal(
      (
        await f.service.update(f.ctx, {
          event_id: id,
          scope: "series",
          expected_revision: before.event.revision!,
          request_id: randomUUID(),
          patch: { title: "Renamed" },
        })
      ).status,
      "updated_verified",
    );
    const raw = f.dav.data.get(url)!;
    assert.ok(raw.includes("BYHOUR=9"));
    assert.ok(raw.includes("DTEND;VALUE=DATE:20240101"));
    assert.ok(raw.includes("X-KEEP:original"));
  } finally {
    f.close();
  }
});

test("CalDAV DELETE sends a strong condition and Schedule-Reply:F, with no scheduling body", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  const requests: {
    method?: string;
    match: string | null;
    reply: string | null;
    body: unknown;
  }[] = [];
  try {
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        method: init?.method,
        match: headers.get("If-Match"),
        reply: headers.get("Schedule-Reply"),
        body: init?.body,
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const adapter = new CalDAVAdapter(f.cfg, {
      get: async () => "test-password",
    });
    await adapter.remove(
      f.ctx,
      "https://caldav.icloud.com/home/personal/spam.ics",
      '"strong-etag"',
    );
    assert.deepEqual(requests, [
      { method: "DELETE", match: '"strong-etag"', reply: "F", body: undefined },
    ]);
  } finally {
    globalThis.fetch = original;
    f.operations.close();
  }
});

test("calendar mutation saves exact original ICS in a private recovery file", async () => {
  const { mkdtemp, mkdir, readdir, readFile, stat } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = setup(),
    directory = await mkdtemp(join(tmpdir(), "a2a-calendar-backup-"));
  try {
    const service = new AdvancedCalendarService(
      f.cfg,
      f.dav,
      f.refs,
      f.operations,
      f.state,
      directory,
    );
    const made = await service.create(f.ctx, eventInput()),
      before = await service.get(f.ctx, { event_id: made.resource.event_id });
    const original = [...f.dav.data.values()][0]!;
    await service.delete(f.ctx, {
      event_id: made.resource.event_id,
      expected_revision: before.event.revision!,
      request_id: randomUUID(),
    });
    const backups = await readdir(join(directory, "backups/calendar"));
    assert.equal(backups.length, 1);
    const path = join(directory, "backups/calendar", backups[0]!);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    f.close();
  }
});

test("self-organizer metadata without other participants remains editable", async () => {
  const f = setup();
  try {
    const s = seedInvitation(f, { organizerOwn: true });
    f.dav.data.set(
      s.url,
      f.dav.data
        .get(s.url)!
        .replace("ATTENDEE:mailto:other@example.com\r\n", ""),
    );
    const before = await f.service.get(f.ctx, {
      event_id: s.id,
      scope: "series",
    });
    assert.equal(before.event.scheduling_role, "personal");
    assert.equal(
      (
        await f.service.update(f.ctx, {
          event_id: s.id,
          scope: "series",
          expected_revision: before.event.revision!,
          request_id: randomUUID(),
          patch: { title: "Renamed own event" },
        })
      ).status,
      "updated_verified",
    );
  } finally {
    f.close();
  }
});
