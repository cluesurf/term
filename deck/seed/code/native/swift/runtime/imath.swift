// Integer math over swift (Int). Mirrors the host Math operations the other targets use. Reached only through the
// public math API.
import Foundation

enum imath {
    static func abs(_ value: Int) -> Int { return Swift.abs(value) }
    static func min(_ a: Int, _ b: Int) -> Int { return Swift.min(a, b) }
    static func max(_ a: Int, _ b: Int) -> Int { return Swift.max(a, b) }
    static func pow(_ base: Int, _ exponent: Int) -> Int { return Int(Foundation.pow(Double(base), Double(exponent))) }
    static func signum(_ value: Int) -> Int { return value.signum() }
    static func sqrt(_ value: Int) -> Int { return Int(Double(value).squareRoot()) }
}
