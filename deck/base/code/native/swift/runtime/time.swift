import Foundation

enum time {
    static func now() -> Int { return Int(Date().timeIntervalSince1970 * 1000) }
}
