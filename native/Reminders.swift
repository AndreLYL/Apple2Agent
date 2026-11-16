// Adapted from epinethrone/icloud-mcp (MIT), commit c6aff4f. See THIRD_PARTY_NOTICES.md.
import EventKit
import Foundation
import CryptoKit
var writeStarted=false

// MARK: - Output helpers

func fail(_ message: String) -> Never {
    let code = message.contains("not granted") || message.contains("not yet asked") ? "PERMISSION_DENIED" : message.contains("not found") ? "STALE_REFERENCE" : message.contains("stale") ? "STALE_REVISION" : message.contains("grant") ? "PERMISSION_DENIED" : "INVALID_INPUT"
    printJSON(["error":["code":code,"message":message,"next_action":"Check selected Reminders sources/lists and system permissions.","write_state":writeStarted ? "outcome_unknown":"failed_before_write"]])
    exit(1)
}

func printJSON(_ value: Any) {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: []) else {
        fail("internal error: the result could not be encoded as JSON")   // v1 wrote an empty body here, which surfaced as the useless "the script returned something that is not JSON"
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func jsonOrNull(_ s: String?) -> Any { s ?? NSNull() }   // a bare Swift nil inside [String: Any] is NOT valid JSON input and made v1 emit nothing

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 1048576, let envelope = (try? JSONSerialization.jsonObject(with: input)) as? [String:Any],
 let op = envelope["operation"] as? String, let args = envelope["args"] as? [String:Any] else { fail("invalid structured input") }
let grants = args["grants"] as? [String:Any] ?? [:]
let allowedLists = Set(grants["lists"] as? [String] ?? [])
let allowedSources = Set(grants["sources"] as? [String] ?? [])
let discovering = op == "discover" // reachable only from trusted local setup, never a registered MCP operation
func digest(_ value: Any) -> String {
 guard let data = try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys,.fragmentsAllowed]) else { fail("cannot compute revision") }
 return SHA256.hash(data:data).map { String(format:"%02x",$0) }.joined()
}

// MARK: - Access
//
// EventKit needs "Full Access to Reminders", which is a DIFFERENT grant from the Automation grant the JXA path uses; the installer and
// self-test both need a new check. The failure this guards against: with no grant, calendars(for:) returns [] and fetches return [] with
// no error at all, so a denied helper looks exactly like an empty Reminders. Every op therefore checks status explicitly, including
// reminder_lists, which v1 did not check at all.

// Switched on rawValue on purpose: .authorized is deprecated on macOS 14+ while .fullAccess / .writeOnly do not exist below it, so
// naming both in one switch either warns or fails to build depending on the SDK. The raw values are stable API.
func authorizationDescription(_ status: EKAuthorizationStatus) -> String {
    switch status.rawValue {
    case 0: return "not yet asked"
    case 1: return "blocked by a device policy (Screen Time or MDM)"
    case 2: return "denied"
    case 3: return "granted"
    case 4: return "write-only, which is not enough to read reminders"
    default: return "unknown (\(status.rawValue))"
    }
}

func hasFullAccess(_ status: EKAuthorizationStatus) -> Bool { status.rawValue == 3 }

let store = EKEventStore()

// EventKit may deliver authorization/fetch completions on the main run loop.
// Blocking that thread with semaphore.wait prevents the permission flow finishing.
func waitForCallback(_ semaphore: DispatchSemaphore, seconds: TimeInterval) -> Bool {
    if !Thread.isMainThread { return semaphore.wait(timeout: .now() + seconds) == .success }
    let deadline = Date().addingTimeInterval(seconds)
    while semaphore.wait(timeout: .now()) != .success {
        if Date() >= deadline { return false }
        _ = RunLoop.current.run(mode: .default, before: min(deadline, Date().addingTimeInterval(0.05)))
    }
    return true
}

@discardableResult
func ensureAccess() -> EKAuthorizationStatus {
    var status = EKEventStore.authorizationStatus(for: .reminder)
    if status == .notDetermined {
        let sem = DispatchSemaphore(value: 0)
        var requestError: Error?
        guard #available(macOS 14.0, *) else { fail("this helper needs macOS 14 or newer for EventKit reminder access") }
        store.requestFullAccessToReminders { _, err in requestError = err; sem.signal() }
        _ = waitForCallback(sem, seconds: 45)
        status = EKEventStore.authorizationStatus(for: .reminder)
        if status == .notDetermined {
            fail("macOS did not complete the Reminders permission request. Keep this Mac unlocked and respond to the Apple2Agent permission dialog."
                 + (requestError.map { " (\($0.localizedDescription))" } ?? "."))
        }
    }
    guard hasFullAccess(status) else {
        fail("Full Access to Reminders is not granted (currently: \(authorizationDescription(status))). Enable \"Apple2Agent "
             + "(Reminders)\" in System Settings > Privacy & Security > Reminders, then try again.")
    }
    return status
}

// MARK: - Due dates
//
// THE OFFSET DECISION, written down because this is the bit that goes wrong quietly.
//
// EventKit stores a reminder's due date as DateComponents, not as an instant. The JXA path stores an absolute Date, which Reminders then
// DISPLAYS in whatever zone the Mac is in. So the only way to keep behaviour identical across the cutover is a two-step:
//   1. resolve the input to one absolute instant, honouring an explicit offset (or Z) when the string carries one, and treating a bare
//      local date-time as local, exactly as `new Date("...")` does in the JS scripts;
//   2. express that instant as wall-clock components in the Mac's CURRENT zone, and pin comps.timeZone to that zone.
//
// Why local components and not the source offset's components: Reminders shows a due date at the pinned wall time, so pinning
// 2026-03-01T09:00+05:00 as 09:00 in a +05:00 zone would display 05:00 in Amsterdam, while the JXA path displays 05:00 too but stores the
// same instant. Converting to local components keeps BOTH the displayed time and the instant identical to today's behaviour.
// Why pinned rather than floating (comps.timeZone = nil): a floating due date follows the device across zones, which JXA's absolute Date
// does not. Pinning matches current behaviour. A bare date is pinned too, for the same reason, even though floating would arguably be
// nicer for "sometime on the 3rd" - that would be a behaviour change and belongs in its own decision, not in a port.
//
// Rules preserved from parseDue() in reminder_create.js / reminder_update.js: a bare date means 09:00 local; an impossible calendar date
// (2026-02-30) is refused rather than rolled over; hour > 23 or minute > 59 is refused. Seconds and fractional seconds are accepted and
// ignored down to the second, which validate_args()'s _ISO regex already permits and v1's prefix-match silently dropped along with the
// whole offset.

let localZone = TimeZone.current
let localCalendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone.current
    return c
}()

let dueBare = try! NSRegularExpression(pattern: "^(\\d{4})-(\\d{2})-(\\d{2})$")
let dueFull = try! NSRegularExpression(
    pattern: "^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?$")

func intAt(_ s: NSString, _ m: NSTextCheckingResult, _ i: Int) -> Int? {
    let r = m.range(at: i)
    return r.location == NSNotFound ? nil : Int(s.substring(with: r))
}

func realCalendarDate(_ y: Int, _ mo: Int, _ d: Int) -> Bool {
    var probe = DateComponents(); probe.year = y; probe.month = mo; probe.day = d; probe.hour = 12
    guard let date = localCalendar.date(from: probe) else { return false }
    let back = localCalendar.dateComponents([.year, .month, .day], from: date)
    return back.year == y && back.month == mo && back.day == d     // refuse a roll-over the way the JS probe does
}

func zoneFor(offset: String) -> TimeZone? {
    if offset == "Z" { return TimeZone(secondsFromGMT: 0) }
    let sign = offset.hasPrefix("-") ? -1 : 1
    let digits = offset.dropFirst().replacingOccurrences(of: ":", with: "")
    guard digits.count == 4, let hh = Int(digits.prefix(2)), let mm = Int(digits.suffix(2)), hh <= 23, mm <= 59 else { return nil }
    return TimeZone(secondsFromGMT: sign * (hh * 3600 + mm * 60))
}

/// Resolves an input string to the absolute instant it names.
func dueInstant(_ s: String) -> Date {
    let ns = s as NSString
    let range = NSRange(location: 0, length: ns.length)

    if let m = dueBare.firstMatch(in: s, range: range) {
        guard let y = intAt(ns, m, 1), let mo = intAt(ns, m, 2), let d = intAt(ns, m, 3), realCalendarDate(y, mo, d) else { fail("invalid due date") }
        var c = DateComponents(); c.year = y; c.month = mo; c.day = d; c.hour = 9; c.minute = 0; c.second = 0
        c.timeZone = localZone
        guard let date = localCalendar.date(from: c) else { fail("invalid due date") }
        return date
    }

    guard let m = dueFull.firstMatch(in: s, range: range),
          let y = intAt(ns, m, 1), let mo = intAt(ns, m, 2), let d = intAt(ns, m, 3),
          let h = intAt(ns, m, 4), let mi = intAt(ns, m, 5) else { fail("invalid due date") }
    let sec = intAt(ns, m, 6) ?? 0
    guard h <= 23, mi <= 59, sec <= 59, realCalendarDate(y, mo, d) else { fail("invalid due date") }

    var c = DateComponents(); c.year = y; c.month = mo; c.day = d; c.hour = h; c.minute = mi; c.second = sec

    let offsetRange = m.range(at: 7)
    if offsetRange.location != NSNotFound {
        guard let zone = zoneFor(offset: ns.substring(with: offsetRange)) else { fail("invalid due date") }
        var srcCalendar = Calendar(identifier: .gregorian)
        srcCalendar.timeZone = zone
        c.timeZone = zone
        guard let date = srcCalendar.date(from: c) else { fail("invalid due date") }
        return date                                          // an explicit offset names one instant, wherever this Mac happens to be
    }

    c.timeZone = localZone
    guard let date = localCalendar.date(from: c) else { fail("invalid due date") }
    return date                                              // no offset means local time, matching `new Date("2026-03-01T09:00")`
}

/// The components actually stored on the reminder: local wall clock, pinned to this Mac's zone.
func dueComponents(_ s: String) -> DateComponents {
    if s.count == 10 {
        let parts = s.split(separator:"-").compactMap { Int($0) }
        guard parts.count == 3, realCalendarDate(parts[0],parts[1],parts[2]) else { fail("invalid date-only due") }
        return DateComponents(calendar:localCalendar,year:parts[0],month:parts[1],day:parts[2])
    }
    var comps = localCalendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: dueInstant(s))
    comps.timeZone = localZone
    return comps
}

/// The inverse, for output. Honours a pinned zone if the reminder carries one (it may have been written on another device).
func dueISO(_ comps: DateComponents?) -> String? {
    guard let comps = comps else { return nil }
    if comps.hour == nil, let y=comps.year, let m=comps.month, let d=comps.day { return String(format:"%04d-%02d-%02d",y,m,d) }
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = comps.timeZone ?? localZone
    guard let date = cal.date(from: comps) else { return nil }
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone(secondsFromGMT: 0)                 // always UTC "Z", matching Date.toISOString() in the JS scripts. The Python
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]   // cache sorts these strings lexicographically, so one fixed shape matters.
    return f.string(from: date)
}

// MARK: - Lists and reminders

func allLists() -> [EKCalendar] { store.calendars(for: .reminder).filter { discovering || allowedLists.contains($0.calendarIdentifier) } }
func listJSON(_ list: EKCalendar) -> [String:Any] {
 return ["id":list.calendarIdentifier,"name":list.title,"source_id":list.source.sourceIdentifier,"account":list.source.title,"writable":list.allowsContentModifications,"revision":digest([list.calendarIdentifier,list.title,list.source.sourceIdentifier])]
}

func findList(id: String?, name: String?) -> EKCalendar {
    let lists = allLists()
    if let id = id {
        guard let l = lists.first(where: { $0.calendarIdentifier == id }) else { fail("list not found (-1728)") }
        return l
    }
    if let name = name {
        let hits = lists.filter { $0.title == name }
        if hits.isEmpty { fail("list not found (-1728): \(name)") }
        if hits.count > 1 { fail("several lists are named '\(name)'; pass list_id (from reminders_list_lists) to choose one") }
        return hits[0]
    }
    fail("an explicit granted list_id is required")
}

/// JXA ids are "x-apple-reminder://<calendarItemIdentifier>"; everything here uses the bare form, and accepts either.
let jxaIdPrefix = "x-apple-reminder://"
func bareId(_ id: String) -> String { id.hasPrefix(jxaIdPrefix) ? String(id.dropFirst(jxaIdPrefix.count)) : id }

func reminderJSON(_ r: EKReminder) -> [String: Any] {
    var out: [String: Any] = ["id": bareId(r.calendarItemIdentifier), "title": r.title ?? "", "notes": r.notes ?? "", "completed": r.isCompleted,
            "due": jsonOrNull(dueISO(r.dueDateComponents)), "priority": r.priority,
            "list": r.calendar.title, "list_id": r.calendar.calendarIdentifier, "account": r.calendar.source.title]
    if let rule = r.recurrenceRules?.first { out["repeat"] = ruleText(rule) }
    let alerts: [[String: Any]] = (r.alarms ?? []).compactMap { a in
        if let d = a.absoluteDate { return ["at": isoZ(d)] }
        return ["minutes_before": Int((-a.relativeOffset / 60).rounded())]
    }
    if !alerts.isEmpty { out["alerts"] = alerts }
    if let done = r.completionDate { out["completed_at"] = isoZ(done) }
    out["source_id"] = r.calendar.source.sourceIdentifier
    out["created_at"] = r.creationDate.map(isoZ) ?? ""
    out["modified_at"] = r.lastModifiedDate.map(isoZ) ?? ""
    out["revision"] = digest(out)
    return out
}

func fetchIncomplete(in lists: [EKCalendar]) -> [EKReminder] {
    let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)
    let sem = DispatchSemaphore(value: 0)
    var out: [EKReminder] = []
    var answered = false
    store.fetchReminders(matching: predicate) { r in out = r ?? []; answered = true; sem.signal() }
    if !waitForCallback(sem, seconds: 55) || !answered {
        fail("Reminders did not answer within 55s")          // silence here used to be indistinguishable from an empty list
    }
    return out
}

func findReminder(id: String) -> EKReminder {
    guard let item = store.calendarItem(withIdentifier: bareId(id)) as? EKReminder else { fail("reminder not found (-1728)") }
    guard allowedLists.contains(item.calendar.calendarIdentifier) else { fail("reminder list is outside grant") }
    return item
}

func saveOrFail(_ r: EKReminder) {
    writeStarted=true
    do { try store.save(r, commit: true) } catch { fail("could not save: \(error.localizedDescription)") }
}

// MARK: - Repeat rules, alerts, completed reminders

// A subset of RFC 5545 RRULE, as the tools accept it: FREQ (DAILY, WEEKLY, MONTHLY or YEARLY; nothing finer, which is also what the
// calendar refuses), INTERVAL, BYDAY (with an ordinal like 1MO or -1FR for monthly and yearly rules), BYMONTHDAY, BYMONTH, and COUNT
// or UNTIL. Anything else is refused by name rather than silently dropped.
let weekdays: [String: EKWeekday] = ["SU": .sunday, "MO": .monday, "TU": .tuesday, "WE": .wednesday, "TH": .thursday, "FR": .friday, "SA": .saturday]

func untilDate(_ v: String) -> Date {
    let compact = try! NSRegularExpression(pattern: "^(\\d{4})(\\d{2})(\\d{2})(?:T(\\d{2})(\\d{2})(\\d{2})Z?)?$")
    let ns = v as NSString
    if let m = compact.firstMatch(in: v, range: NSRange(location: 0, length: ns.length)) {
        let y = intAt(ns, m, 1)!, mo = intAt(ns, m, 2)!, d = intAt(ns, m, 3)!
        guard realCalendarDate(y, mo, d) else { fail("UNTIL is not a real date: \(v)") }
        var comps = DateComponents(year: y, month: mo, day: d, hour: intAt(ns, m, 4) ?? 23, minute: intAt(ns, m, 5) ?? 59, second: intAt(ns, m, 6) ?? 59)
        comps.timeZone = m.range(at: 4).location != NSNotFound ? TimeZone(secondsFromGMT: 0) : localZone
        var cal = Calendar(identifier: .gregorian); cal.timeZone = comps.timeZone!
        return cal.date(from: comps)!
    }
    return dueInstant(v)                                     // an ISO date or date-time, as for due dates
}

func recurrenceRule(_ text: String) -> EKRecurrenceRule {
    var parts: [String: String] = [:]
    for piece in text.replacingOccurrences(of: "RRULE:", with: "").split(separator: ";") {
        let kv = piece.split(separator: "=", maxSplits: 1).map { String($0).trimmingCharacters(in: .whitespaces).uppercased() }
        guard kv.count == 2, !kv[1].isEmpty else { fail("repeat: '\(piece)' is not KEY=VALUE") }
        if parts[kv[0]] != nil { fail("duplicate repeat rule field") }
        parts[kv[0]] = kv[1]
    }
    let known: Set<String> = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "COUNT", "UNTIL"]
    if let odd = parts.keys.first(where: { !known.contains($0) }) { fail("repeat: \(odd) is not supported (use FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYMONTH, COUNT or UNTIL)") }
    let freqs: [String: EKRecurrenceFrequency] = ["DAILY": .daily, "WEEKLY": .weekly, "MONTHLY": .monthly, "YEARLY": .yearly]
    guard let freqName = parts["FREQ"], let freq = freqs[freqName] else { fail("repeat needs FREQ=DAILY, WEEKLY, MONTHLY or YEARLY") }
    let interval = Int(parts["INTERVAL"] ?? "1") ?? 0
    guard interval >= 1 && interval <= 999 else { fail("repeat: INTERVAL must be 1 to 999") }
    var days: [EKRecurrenceDayOfWeek]? = nil
    if let byday = parts["BYDAY"] {
        days = byday.split(separator: ",").map { token in
            let t = String(token)
            let code = String(t.suffix(2)), ordinal = String(t.dropLast(2))
            guard let wd = weekdays[code] else { fail("repeat: '\(t)' is not a weekday") }
            if ordinal.isEmpty { return EKRecurrenceDayOfWeek(wd) }
            guard let n = Int(ordinal), n != 0, abs(n) <= 53, freq == .monthly || freq == .yearly else {
                fail("repeat: '\(t)' needs FREQ=MONTHLY or YEARLY and an ordinal like 1 or -1")
            }
            return EKRecurrenceDayOfWeek(wd, weekNumber: n)
        }
    }
    let ints: (String, ClosedRange<Int>) -> [NSNumber]? = { key, range in
        guard let v = parts[key] else { return nil }
        return v.split(separator: ",").map { x -> NSNumber in
            guard let n = Int(x), range.contains(abs(n)), n != 0 else { fail("repeat: \(key) value '\(x)' is out of range") }
            return NSNumber(value: n)
        }
    }
    let monthDays = ints("BYMONTHDAY", 1...31), months = ints("BYMONTH", 1...12)
    if months?.contains(where: { $0.intValue < 1 }) == true { fail("BYMONTH must be positive") }
    if freq == .weekly && monthDays != nil { fail("BYMONTHDAY is not supported with WEEKLY") }
    if parts["COUNT"] != nil && parts["UNTIL"] != nil { fail("COUNT and UNTIL are mutually exclusive") }
    var end: EKRecurrenceEnd? = nil
    if let count = parts["COUNT"] {
        guard let n = Int(count), n >= 1 && n <= 1000 else { fail("repeat: COUNT must be 1 to 1000") }
        end = EKRecurrenceEnd(occurrenceCount: n)
    } else if let until = parts["UNTIL"] {
        end = EKRecurrenceEnd(end: untilDate(until))
    }
    return EKRecurrenceRule(recurrenceWith: freq, interval: interval, daysOfTheWeek: days, daysOfTheMonth: monthDays,
                            monthsOfTheYear: months, weeksOfTheYear: nil, daysOfTheYear: nil, setPositions: nil, end: end)
}

func ruleText(_ r: EKRecurrenceRule) -> String {
    let names: [EKRecurrenceFrequency: String] = [.daily: "DAILY", .weekly: "WEEKLY", .monthly: "MONTHLY", .yearly: "YEARLY"]
    var out = ["FREQ=\(names[r.frequency] ?? "DAILY")"]
    if r.interval > 1 { out.append("INTERVAL=\(r.interval)") }
    let codes = Dictionary(uniqueKeysWithValues: weekdays.map { ($1, $0) })
    if let d = r.daysOfTheWeek, !d.isEmpty {
        out.append("BYDAY=" + d.map { ($0.weekNumber != 0 ? String($0.weekNumber) : "") + (codes[$0.dayOfTheWeek] ?? "MO") }.joined(separator: ","))
    }
    if let d = r.daysOfTheMonth, !d.isEmpty { out.append("BYMONTHDAY=" + d.map { $0.stringValue }.joined(separator: ",")) }
    if let m = r.monthsOfTheYear, !m.isEmpty { out.append("BYMONTH=" + m.map { $0.stringValue }.joined(separator: ",")) }
    if let e = r.recurrenceEnd {
        if e.occurrenceCount > 0 { out.append("COUNT=\(e.occurrenceCount)") }
        else if let d = e.endDate {
            let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(secondsFromGMT: 0)
            f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
            out.append("UNTIL=" + f.string(from: d))
        }
    }
    return out.joined(separator: ";")
}

func isoZ(_ d: Date) -> String {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone(secondsFromGMT: 0)
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: d)
}

/// Alerts from the tool arguments: "30,5" minutes before the due time and/or "iso,iso" absolute times. nil when neither was given.
func alarms(before: String?, at: String?) -> [EKAlarm]? {
    guard before != nil || at != nil else { return nil }
    var out: [EKAlarm] = []
    for m in (before ?? "").split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) }) where !m.isEmpty {
        guard let n = Int(m), n >= 0 && n <= 60 * 24 * 60 else { fail("alerts_minutes_before: '\(m)' must be 0 to 86400 minutes") }
        out.append(EKAlarm(relativeOffset: TimeInterval(-n * 60)))
    }
    for t in (at ?? "").split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) }) where !t.isEmpty {
        out.append(EKAlarm(absoluteDate: dueInstant(t)))
    }
    if out.count > 10 { fail("at most 10 alerts") }
    return out
}

/// The alert the Reminders app keeps at the due time itself (an absolute alarm at exactly the due instant): kept when alerts are replaced.
func dueAlarm(_ r: EKReminder) -> EKAlarm? {
    guard let comps = r.dueDateComponents, comps.hour != nil else { return nil }
    var cal = Calendar(identifier: .gregorian); cal.timeZone = comps.timeZone ?? localZone
    guard let due = cal.date(from: comps) else { return nil }
    return (r.alarms ?? []).first { a in a.absoluteDate.map { abs($0.timeIntervalSince(due)) < 1 } ?? false }
}

func applyAlarms(_ r: EKReminder, _ new: [EKAlarm]) {
    let keep = dueAlarm(r)
    for a in r.alarms ?? [] { r.removeAlarm(a) }
    if let keep = keep { r.addAlarm(keep) }
    for a in new { r.addAlarm(a) }
}

func fetch(_ predicate: NSPredicate) -> [EKReminder] {
    let sem = DispatchSemaphore(value: 0)
    var out: [EKReminder] = []
    var answered = false
    store.fetchReminders(matching: predicate) { r in out = r ?? []; answered = true; sem.signal() }
    if !waitForCallback(sem, seconds: 55) || !answered { fail("Reminders did not answer within 55s") }
    return out
}

// MARK: - Dispatch

switch op {
case "authorization_status":
    let status = EKEventStore.authorizationStatus(for: .reminder)
    printJSON(["authorization":authorizationDescription(status),"raw_status":status.rawValue,"usage_description_present":Bundle.main.object(forInfoDictionaryKey:"NSRemindersFullAccessUsageDescription") is String,"bundle_identifier":Bundle.main.bundleIdentifier ?? ""])
case "validate":
    let comps=(args["due"] as? String).map(dueComponents)
    let rule=(args["repeat"] as? String).map(recurrenceRule)
    let alerts=alarms(before:args["alerts_before"] as? String,at:args["alerts_at"] as? String)
    printJSON(["due":jsonOrNull(dueISO(comps)),"date_only":comps != nil && comps?.hour == nil,"repeat":rule.map(ruleText) ?? "","alarms":alerts?.count ?? 0])
case "discover":
    ensureAccess()
    printJSON(["lists":allLists().map(listJSON),"sources":store.sources.map { ["id":$0.sourceIdentifier,"name":$0.title,"type":$0.sourceType.rawValue] }])
case "reminder_get":
    ensureAccess(); guard let id=args["id"] as? String else { fail("id required") }
    printJSON(reminderJSON(findReminder(id:id)))
case "list_get":
    ensureAccess(); printJSON(listJSON(findList(id:args["list_id"] as? String,name:nil)))
case "preflight":
    ensureAccess()
    if let due=args["due"] as? String { _=dueComponents(due) }
    if let rule=args["repeat"] as? String { _=recurrenceRule(rule) }
    _=alarms(before:args["alerts_before"] as? String,at:args["alerts_at"] as? String)
    if let id=args["id"] as? String { let r=findReminder(id:id); if let expected=args["expected_revision"] as? String, expected != reminderJSON(r)["revision"] as? String { fail("stale reminder revision") } }
    if let id=args["list_id"] as? String { _=findList(id:id,name:nil) }
    if let id=args["source_id"] as? String, !allowedSources.contains(id) { fail("source outside grant") }
    printJSON(["ready":true])

case "reminder_lists":
    ensureAccess()
    let lists=allLists()
    if !allowedLists.isEmpty && lists.isEmpty { fail("configured reminder lists not found") }
    printJSON(["lists":lists.map(listJSON),"sources":store.sources.filter{allowedSources.contains($0.sourceIdentifier)}.map{["id":$0.sourceIdentifier,"name":$0.title,"type":$0.sourceType.rawValue]}])

case "reminders_list":
    ensureAccess()
    let listId = args["list_id"] as? String
    let listName = args["list"] as? String
    let lists: [EKCalendar] = (listId != nil || listName != nil) ? [findList(id: listId, name: listName)] : allLists()
    if lists.isEmpty { fail("Reminders reported no lists at all, which usually means the account has not finished loading; try again shortly") }
    let mode = (args["completed"] as? String) ?? "no"
    guard ["no", "only", "all"].contains(mode) else { fail("completed must be no, only or all") }
    var items = mode == "only" ? [] : fetchIncomplete(in: lists)
    var done: [EKReminder] = []
    if mode != "no" {
        let before = (args["completed_before"] as? String).map(dueInstant) ?? Date()
        let since = (args["completed_since"] as? String).map(dueInstant) ?? before.addingTimeInterval(-30 * 86400)
        guard since < before, before.timeIntervalSince(since) <= 366 * 86400 else { fail("the completed window must be at most 366 days, since before before") }
        done = fetch(store.predicateForCompletedReminders(withCompletionDateStarting: since, ending: before, calendars: lists))
        done.sort { ($0.completionDate ?? .distantPast) > ($1.completionDate ?? .distantPast) }    // newest first
    }
    if let q = (args["query"] as? String)?.lowercased(), !q.isEmpty {
        items = items.filter { ($0.title ?? "").lowercased().contains(q) || ($0.notes ?? "").lowercased().contains(q) }
        done = done.filter { ($0.title ?? "").lowercased().contains(q) || ($0.notes ?? "").lowercased().contains(q) }
    }
    let keyed = items.map { (r: $0, due: dueISO($0.dueDateComponents)) }
        .sorted { a, b in
            if a.due == nil && b.due == nil { return false }
            if a.due == nil { return false }
            if b.due == nil { return true }
            return a.due! < b.due!                           // same "undated last, then ascending" order the cache produces
        }
    let limit = max(1, (args["limit"] as? Int) ?? 50)
    var rows = keyed.map { $0.r } + done
    if let since=args["due_since"] as? String { rows=rows.filter { dueISO($0.dueDateComponents).map { $0 >= since } ?? false } }
    if let before=args["due_before"] as? String { rows=rows.filter { dueISO($0.dueDateComponents).map { $0 < before } ?? false } }                     // active first (soonest due), then completed (newest first)
    printJSON(["reminders": rows.prefix(limit).map { reminderJSON($0) },"complete":rows.count<=limit,"scanned":rows.count])   // no "cached" key: every read is live

case "reminder_create":
    ensureAccess()
    guard let title = args["title"] as? String, !title.isEmpty else { fail("title is required") }
    let comps = (args["due"] as? String).map(dueComponents)  // validate the date BEFORE creating anything, as the JS script does
    let list = findList(id: args["list_id"] as? String, name: args["list"] as? String)
    let r = EKReminder(eventStore: store)
    r.title = title
    r.calendar = list
    if let notes = args["notes"] as? String { r.notes = notes }
    if let priority = args["priority"] as? Int { r.priority = priority }
    if let comps = comps { r.dueDateComponents = comps }
    let rule = (args["repeat"] as? String).map(recurrenceRule)          // parsed before saving anything
    if rule != nil && comps == nil { fail("a repeating reminder needs a due date") }
    let newAlarms = alarms(before: args["alerts_before"] as? String, at: args["alerts_at"] as? String)
    if let rule = rule { r.addRecurrenceRule(rule) }
    if comps?.hour == nil && newAlarms?.contains(where:{$0.absoluteDate==nil})==true { fail("relative alarms require a timed due") }
    if let newAlarms = newAlarms { for a in newAlarms { r.addAlarm(a) } }
    saveOrFail(r)
    printJSON(reminderJSON(r))

case "reminder_update":
    ensureAccess()
    guard let id = args["id"] as? String else { fail("id is required") }
    let clearDue = (args["clear_due"] as? Bool) == true
    let comps = clearDue ? nil : (args["due"] as? String).map(dueComponents)   // validate BEFORE touching anything: v1 mutated title and
    let touchesDue = clearDue || comps != nil                                  // notes first and could leave a half-applied edit behind
    let rule = (args["repeat"] as? String).map(recurrenceRule)
    let clearRepeat = (args["clear_repeat"] as? Bool) == true
    let newAlarms = alarms(before: args["alerts_before"] as? String, at: args["alerts_at"] as? String)
    guard args["title"] as? String != nil || args["notes"] as? String != nil || args["priority"] as? Int != nil || touchesDue
          || rule != nil || clearRepeat || newAlarms != nil else {
        fail("nothing to update")
    }
    let r = findReminder(id: id)
    if let expected = args["expected_revision"] as? String, expected != reminderJSON(r)["revision"] as? String { fail("stale reminder revision") }
    if rule != nil && ((clearDue) || (comps == nil && r.dueDateComponents == nil)) { fail("a repeating reminder needs a due date") }
    if touchesDue && comps?.hour == nil && (newAlarms ?? r.alarms ?? []).contains(where:{$0.absoluteDate==nil}) { fail("clear relative alarms explicitly or keep a timed due") }
    if !touchesDue && r.dueDateComponents?.hour == nil && newAlarms?.contains(where:{$0.absoluteDate==nil})==true { fail("relative alarms require a timed due") }
    if let title = args["title"] as? String { r.title = title }
    if let notes = args["notes"] as? String { r.notes = notes }
    if let priority = args["priority"] as? Int { r.priority = priority }
    if touchesDue { r.dueDateComponents = comps }
    if clearRepeat || rule != nil { for old in r.recurrenceRules ?? [] { r.removeRecurrenceRule(old) } }
    if let rule = rule { r.addRecurrenceRule(rule) }
    if let newAlarms = newAlarms { applyAlarms(r, newAlarms) }
    saveOrFail(r)
    printJSON(reminderJSON(r))

case "reminder_complete":
    ensureAccess()
    guard let id = args["id"] as? String else { fail("id is required") }
    let r = findReminder(id: id)
    if let expected = args["expected_revision"] as? String, expected != reminderJSON(r)["revision"] as? String { fail("stale reminder revision") }
    r.isCompleted = (args["completed"] as? Bool) ?? true
    saveOrFail(r)
    printJSON(reminderJSON(r))

case "reminder_delete":
    ensureAccess()
    guard let id = args["id"] as? String else { fail("id is required") }
    let r = findReminder(id: id)
    if let expected = args["expected_revision"] as? String, expected != reminderJSON(r)["revision"] as? String { fail("stale reminder revision") }
    let title = r.title ?? ""
    writeStarted=true
    do { try store.remove(r, commit: true) } catch { fail("could not delete: \(error.localizedDescription)") }
    printJSON(["deleted": bareId(id), "title": title])

case "reminder_move":
    // Moves the SAME reminder to another list (its id, notes, due date, priority and completion stay), so nothing is deleted and
    // recreated. EventKit cannot move an item between accounts (sources); that is refused with a clear message instead.
    ensureAccess()
    guard let id = args["id"] as? String else { fail("id is required") }
    guard args["list_id"] as? String != nil || args["list"] as? String != nil else { fail("list or list_id is required") }
    let target = findList(id: args["list_id"] as? String, name: args["list"] as? String)
    let r = findReminder(id: id)
    if let expected = args["expected_revision"] as? String, expected != reminderJSON(r)["revision"] as? String { fail("stale reminder revision") }
    let from = r.calendar.title
    if r.calendar.calendarIdentifier == target.calendarIdentifier {
        var out = reminderJSON(r); out["moved"] = false; out["from"] = from
        printJSON(out)
        exit(0)
    }
    guard target.allowsContentModifications else { fail("the list '\(target.title)' is read-only") }
    guard r.calendar.source.sourceIdentifier == target.source.sourceIdentifier else {
        fail("'\(from)' and '\(target.title)' are in different accounts (\(r.calendar.source.title), \(target.source.title)); "
             + "EventKit cannot move a reminder between accounts: create a copy with reminders_create_reminder, then delete the original with reminders_delete_reminder")
    }
    r.calendar = target
    saveOrFail(r)
    var out = reminderJSON(r); out["moved"] = true; out["from"] = from
    printJSON(out)

case "reminder_list_create":
    ensureAccess()
    guard let name = (args["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { fail("name is required") }
    guard let sourceId=args["source_id"] as? String, allowedSources.contains(sourceId), let source=store.sources.first(where: { $0.sourceIdentifier==sourceId }) else { fail("an explicit granted source_id is required") }
    if allLists().contains(where: { $0.source.sourceIdentifier == source.sourceIdentifier && $0.title.lowercased() == name.lowercased() }) {
        fail("there is already a list called '\(name)' in \(source.title)")
    }
    let list = EKCalendar(for: .reminder, eventStore: store)
    list.title = name
    list.source = source
    writeStarted=true
    do { try store.saveCalendar(list, commit: true) } catch { fail("could not create the list: \(error.localizedDescription)") }
    printJSON(listJSON(list))

case "reminder_list_update":
    ensureAccess()
    guard let id = args["list_id"] as? String, let name = (args["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !name.isEmpty else { fail("list_id and name are required") }
    let list = findList(id: id, name: nil)
    if let expected = args["expected_revision"] as? String, expected != listJSON(list)["revision"] as? String { fail("stale list revision") }
    guard list.allowsContentModifications else { fail("the list '\(list.title)' is read-only") }
    list.title = name
    writeStarted=true
    do { try store.saveCalendar(list, commit: true) } catch { fail("could not rename the list: \(error.localizedDescription)") }
    printJSON(listJSON(list))

case "reminder_list_delete":
    // Reminders has no trash: deleting a list deletes every reminder in it for good. The server previews first (preview: the
    // count of every reminder in the list, of any age, done or not, and a sample) and passes delete_reminders, with the count the
    // owner confirmed as expected, only after the owner's yes; this refuses anything else.
    ensureAccess()
    guard let id = args["list_id"] as? String, let name = args["name"] as? String else { fail("list_id and name are required") }
    let list = findList(id: id, name: nil)
    if let expected = args["expected_revision"] as? String, expected != listJSON(list)["revision"] as? String { fail("stale list revision") }
    guard list.title == name else { fail("that list_id is the list '\(list.title)', not '\(name)'. Nothing was deleted.") }
    if let d = store.defaultCalendarForNewReminders(), d.calendarIdentifier == list.calendarIdentifier {
        fail("'\(list.title)' is the default list for new reminders, so it is not deleted")
    }
    guard list.allowsContentModifications else { fail("the list '\(list.title)' is read-only") }
    let items = fetch(store.predicateForReminders(in: [list]))
    let count = items.count
    let snapshot = digest(items.map { reminderJSON($0)["revision"] as? String ?? "" }.sorted())
    if let expected=args["expected_snapshot"] as? String, expected != snapshot { fail("stale list preview") }
    if (args["preview"] as? Bool) == true {
        printJSON(["preview": true, "name": list.title, "reminders": count, "snapshot":snapshot, "sample": items.prefix(3).map { $0.title ?? "" }])
        exit(0)
    }
    if count > 0 && (args["delete_reminders"] as? Bool) != true { fail("the list holds \(count) reminders; nothing was deleted") }
    if let expected = args["expected"] as? Int, expected != count {
        fail("the list holds \(count) reminders now, not the \(expected) that were confirmed; nothing was deleted")
    }
    writeStarted=true
    do { try store.removeCalendar(list, commit: true) } catch { fail("could not delete the list: \(error.localizedDescription)") }
    printJSON(["deleted": true, "name": list.title, "reminders_deleted": count])

default:
    fail("unknown operation \(op)")
}
