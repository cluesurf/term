// Integer math over swift (Int). Mirrors the host Math operations the other targets use. Reached only through the
// public math API.
import Foundation

enum imath {
    static func abs(_ value: Int) -> Int { return Swift.abs(value) }
    static func min(_ a: Int, _ b: Int) -> Int { return Swift.min(a, b) }
    static func max(_ a: Int, _ b: Int) -> Int { return Swift.max(a, b) }
    // the integer power or a stop: by squaring with Swift's trapping `*`. Through Double it was wrong above 2^53. A
    // negative exponent is the real result truncated toward zero: 0, except for a base of 1 or -1, as on Rust and Kotlin
    static func pow(_ base: Int, _ exponent: Int) -> Int {
        if exponent < 0 {
            if base == 0 { fatalError("defect: zero to a negative power") }
            return base == 1 ? 1 : base == -1 ? (exponent % 2 == 0 ? 1 : -1) : 0
        }
        var result = 1, b = base, e = exponent
        while e > 0 {
            if e & 1 == 1 { result *= b }
            e >>= 1
            if e > 0 { b *= b }
        }
        return result
    }
    static func signum(_ value: Int) -> Int { return value.signum() }
    static func sqrt(_ value: Int) -> Int { return Int(Double(value).squareRoot()) }
    static func log(_ value: Int) -> Int { return Int(Foundation.log(Double(value))) }
    static func sin(_ value: Int) -> Int { return Int(Foundation.sin(Double(value))) }
}
