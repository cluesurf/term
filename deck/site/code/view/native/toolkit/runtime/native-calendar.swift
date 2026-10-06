// The person's calendar on AppKit and UIKit (device-layer-0024), docked by ../calendar.tree as `<global:native-calendar>`.
// EventKit: an event is kept in the default calendar for new events, found by EventKit's own span predicate (which
// answers each occurrence of a repeating event), and removed by its identifier. A store is made for each call, since one
// made before the grant was given sees no calendar until it is reset. Times are read as ISO 8601 with their offset and
// answered in UTC to the second (../../../calendar.tree). Without the grant every task answers the grant's status and
// never prompts: asking is request-permission's, the one place that does.

import EventKit
import Foundation

// the calendar grant, brought by the calendar (native-permission.swift), run when the program starts. Full access: the
// module reads events as well as writing them
nativePermission.register(
    "calendar",
    declaration: "NSCalendarsFullAccessUsageDescription",
    status: { nativeCalendar.grant() },
    request: {
        _ = try? await EKEventStore().requestFullAccessToEvents()
        return nativeCalendar.grant()
    }
)

enum nativeCalendar {
    // compared rather than switched: `.authorized` is deprecated since iOS 17 and macOS 14 and warns where it is named.
    // Write-only access is not a grant of this module's
    static func grant() -> String {
        let status = EKEventStore.authorizationStatus(for: .event)
        if status == .fullAccess { return "granted" }
        if status == .notDetermined { return "not-determined" }
        if status == .restricted { return "restricted" }
        return "denied"
    }

    // `added <id>`, or invalid, not-determined, denied, unavailable or failed
    static func add(_ title: String, _ start: String, _ end: String) async -> String {
        if let refused = await refusal() { return refused }
        guard let from = read(start), let to = read(end), to >= from else { return "invalid" }
        let store = EKEventStore()
        guard let calendar = store.defaultCalendarForNewEvents else { return "unavailable" }
        let event = EKEvent(eventStore: store)
        event.title = plain(title)
        event.startDate = from
        event.endDate = to
        event.calendar = calendar
        do {
            try store.save(event, span: .thisEvent, commit: true)
        } catch {
            return "failed"
        }
        guard let id = event.eventIdentifier else { return "failed" }
        return "added \(id)"
    }

    // every event overlapping the span, `start<TAB>end<TAB>title` a line, sorted; or none, invalid, or the grant's status
    static func find(_ from: String, _ to: String) async -> String {
        if let refused = await refusal() { return refused }
        guard let start = read(from), let end = read(to), end >= start else { return "invalid" }
        let store = EKEventStore()
        let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
        let lines = events.map { (start: write($0.startDate), end: write($0.endDate), title: plain($0.title ?? "")) }
            .sorted { $0.start == $1.start ? $0.title.utf16.lexicographicallyPrecedes($1.title.utf16) : $0.start < $1.start }
        if lines.isEmpty { return "none" }
        return lines.map { "\($0.start)\t\($0.end)\t\($0.title)" }.joined(separator: "\n")
    }

    // removed, absent, or the grant's status
    static func remove(_ id: String) async -> String {
        if let refused = await refusal() { return refused }
        let store = EKEventStore()
        guard let event = store.event(withIdentifier: id) else { return "absent" }
        do {
            try store.remove(event, span: .thisEvent, commit: true)
        } catch {
            return "failed"
        }
        return "removed"
    }

    // the grant's status when it is not a grant, `restricted` read as denied as the other capabilities do
    private static func refusal() async -> String? {
        let grant = await nativePermission.status("calendar")
        if grant == "granted" { return nil }
        return grant == "restricted" ? "denied" : grant
    }

    // ISO 8601 with its offset, with or without fractions of a second
    private static func read(_ text: String) -> Date? {
        let whole = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return whole.date(from: text) ?? fractional.date(from: text)
    }

    // UTC, to the second: `2030-01-01T09:00:00Z`, which sorts as text in time order
    private static func write(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    // a tab or a line break would split the answer's lines, so each is read as a space
    private static func plain(_ text: String) -> String {
        String(text.map { $0 == "\t" || $0.isNewline ? " " : $0 })
    }
}
