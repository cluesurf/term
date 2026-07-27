import Foundation

enum clock {
    static func currentTime() -> Int { return Int(ProcessInfo.processInfo.systemUptime * 1000) }
    static func sleep(_ ms: Int) { Thread.sleep(forTimeInterval: Double(ms) / 1000.0) }
}
