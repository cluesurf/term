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
}
