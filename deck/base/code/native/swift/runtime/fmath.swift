import Foundation

enum fmath {
    static func sqrt(_ v: Double) -> Double { return Foundation.sqrt(v) }
    static func floor(_ v: Double) -> Double { return Foundation.floor(v) }
    static func ceil(_ v: Double) -> Double { return Foundation.ceil(v) }
    static func round(_ v: Double) -> Double { return v.rounded() }
    static func pow(_ base: Double, _ exponent: Double) -> Double { return Foundation.pow(base, exponent) }
    static func abs(_ v: Double) -> Double { return Swift.abs(v) }
    static func sin(_ v: Double) -> Double { return Foundation.sin(v) }
    static func cos(_ v: Double) -> Double { return Foundation.cos(v) }
    static func tan(_ v: Double) -> Double { return Foundation.tan(v) }
    static func asin(_ v: Double) -> Double { return Foundation.asin(v) }
    static func acos(_ v: Double) -> Double { return Foundation.acos(v) }
    static func atan(_ v: Double) -> Double { return Foundation.atan(v) }
    static func atan2(_ y: Double, _ x: Double) -> Double { return Foundation.atan2(y, x) }
}
