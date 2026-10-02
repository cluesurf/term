import Foundation

// Calendar over Foundation, all in UTC. Timestamps are epoch milliseconds. ISO8601DateFormatter with fractional
// seconds matches the host-Date and chrono / java.time formatting (2026-06-19T12:34:56.000Z). Components come from a
// gregorian Calendar pinned to UTC.
enum calendar {
    private static let utc = TimeZone(identifier: "UTC")!
    private static var gregorian: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = utc
        return value
    }
    private static let formatter: ISO8601DateFormatter = {
        let value = ISO8601DateFormatter()
        value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        value.timeZone = utc
        return value
    }()
    private static func at(_ millis: Int) -> Date { Date(timeIntervalSince1970: Double(millis) / 1000.0) }
    private static func epoch(_ date: Date) -> Int { Int((date.timeIntervalSince1970 * 1000).rounded()) }
    static func format(_ millis: Int) -> String { formatter.string(from: at(millis)) }
    static func parse(_ text: String) -> Int {
        guard let date = formatter.date(from: text) else { return 0 }
        return epoch(date)
    }
    private static func part(_ millis: Int, _ component: Calendar.Component) -> Int {
        return gregorian.component(component, from: at(millis))
    }
    static func year(_ millis: Int) -> Int { part(millis, .year) }
    static func month(_ millis: Int) -> Int { part(millis, .month) }
    static func day(_ millis: Int) -> Int { part(millis, .day) }
    static func hour(_ millis: Int) -> Int { part(millis, .hour) }
    static func minute(_ millis: Int) -> Int { part(millis, .minute) }
    static func second(_ millis: Int) -> Int { part(millis, .second) }
    static func weekday(_ millis: Int) -> Int { part(millis, .weekday) - 1 }
    static func build(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int, _ second: Int) -> Int {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        components.second = second
        components.timeZone = utc
        guard let date = gregorian.date(from: components) else { return 0 }
        return epoch(date)
    }
    static func addMonths(_ millis: Int, _ count: Int) -> Int {
        guard let date = gregorian.date(byAdding: .month, value: count, to: at(millis)) else { return millis }
        return epoch(date)
    }
    static func addYears(_ millis: Int, _ count: Int) -> Int {
        guard let date = gregorian.date(byAdding: .year, value: count, to: at(millis)) else { return millis }
        return epoch(date)
    }
}
