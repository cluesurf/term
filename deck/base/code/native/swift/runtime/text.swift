import Foundation

enum text {
    static func upper(_ s: String) -> String { return s.uppercased() }
    static func lower(_ s: String) -> String { return s.lowercased() }
    static func trim(_ s: String) -> String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
    static func repeated(_ s: String, _ n: Int) -> String { return String(repeating: s, count: n) }
    static func contains(_ s: String, _ part: String) -> Bool { return s.contains(part) }
    static func startsWith(_ s: String, _ prefix: String) -> Bool { return s.hasPrefix(prefix) }
    static func endsWith(_ s: String, _ suffix: String) -> Bool { return s.hasSuffix(suffix) }
    static func replace(_ s: String, _ from: String, _ to: String) -> String { return s.replacingOccurrences(of: from, with: to) }
    static func slice(_ s: String, _ start: Int, _ end: Int) -> String {
        let characters = Array(s)
        return String(characters[start..<end])
    }
}
