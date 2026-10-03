import Foundation

// Arbitrary-precision integers for Swift, whose standard library has none (integer/big.tree; JS BigInt, Rust
// num-bigint and Java BigInteger on the other backends). Sign and magnitude, the magnitude in 32-bit limbs, least
// significant first, with no high zero limbs, so zero is the empty magnitude and never negative. Division truncates
// toward zero and the remainder takes the dividend's sign, as BigInt, num-bigint and BigInteger do. Text that is not an
// integer and a division by zero stop the run, as they do on the other three. The handle a Term `big-integer` holds is
// a `TermBigInt` boxed as `Any`.

struct TermBigInt {
    var negative: Bool
    var limbs: [UInt32]
}

enum termbig {
    static func trimmed(_ limbs: [UInt32]) -> [UInt32] {
        var out = limbs
        while let last = out.last, last == 0 { out.removeLast() }
        return out
    }

    static func make(_ negative: Bool, _ limbs: [UInt32]) -> TermBigInt {
        let magnitude = trimmed(limbs)
        return TermBigInt(negative: magnitude.isEmpty ? false : negative, limbs: magnitude)
    }

    static func big(_ value: Any) -> TermBigInt { value as! TermBigInt }

    static func compareMagnitude(_ a: [UInt32], _ b: [UInt32]) -> Int {
        if a.count != b.count { return a.count < b.count ? -1 : 1 }
        var i = a.count - 1
        while i >= 0 {
            if a[i] != b[i] { return a[i] < b[i] ? -1 : 1 }
            i -= 1
        }
        return 0
    }

    static func addMagnitude(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
        var out: [UInt32] = []
        var carry: UInt64 = 0
        for i in 0..<max(a.count, b.count) {
            let sum = UInt64(i < a.count ? a[i] : 0) + UInt64(i < b.count ? b[i] : 0) + carry
            out.append(UInt32(truncatingIfNeeded: sum))
            carry = sum >> 32
        }
        if carry > 0 { out.append(UInt32(carry)) }
        return out
    }

    // a minus b, for a at least b
    static func subtractMagnitude(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
        var out: [UInt32] = []
        var borrow: Int64 = 0
        for i in 0..<a.count {
            var digit = Int64(a[i]) - Int64(i < b.count ? b[i] : 0) - borrow
            if digit < 0 {
                digit += 1 << 32
                borrow = 1
            } else {
                borrow = 0
            }
            out.append(UInt32(digit))
        }
        return trimmed(out)
    }

    static func multiplyMagnitude(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
        if a.isEmpty || b.isEmpty { return [] }
        var out = [UInt32](repeating: 0, count: a.count + b.count)
        for i in 0..<a.count {
            var carry: UInt64 = 0
            let left = UInt64(a[i])
            for j in 0..<b.count {
                let part = left * UInt64(b[j]) + UInt64(out[i + j]) + carry
                out[i + j] = UInt32(truncatingIfNeeded: part)
                carry = part >> 32
            }
            var k = i + b.count
            while carry > 0 {
                let part = UInt64(out[k]) + carry
                out[k] = UInt32(truncatingIfNeeded: part)
                carry = part >> 32
                k += 1
            }
        }
        return trimmed(out)
    }

    static func multiplySmall(_ a: [UInt32], _ factor: UInt32, _ addend: UInt32) -> [UInt32] {
        var out: [UInt32] = []
        var carry = UInt64(addend)
        for limb in a {
            let part = UInt64(limb) * UInt64(factor) + carry
            out.append(UInt32(truncatingIfNeeded: part))
            carry = part >> 32
        }
        if carry > 0 { out.append(UInt32(carry)) }
        return trimmed(out)
    }

    static func divideSmall(_ a: [UInt32], _ divisor: UInt32) -> ([UInt32], UInt32) {
        var out = [UInt32](repeating: 0, count: a.count)
        var rest: UInt64 = 0
        var i = a.count - 1
        while i >= 0 {
            let current = (rest << 32) | UInt64(a[i])
            out[i] = UInt32(current / UInt64(divisor))
            rest = current % UInt64(divisor)
            i -= 1
        }
        return (trimmed(out), UInt32(rest))
    }

    // the magnitude shifted up one bit, with `bit` coming in at the bottom
    static func shiftedUp(_ a: [UInt32], _ bit: UInt32) -> [UInt32] {
        var out: [UInt32] = []
        var carry = bit
        for limb in a {
            out.append((limb << 1) | carry)
            carry = limb >> 31
        }
        if carry > 0 { out.append(carry) }
        return out
    }

    static func divideMagnitude(_ a: [UInt32], _ b: [UInt32]) -> ([UInt32], [UInt32]) {
        if b.isEmpty { fatalError("defect: a big integer divided by zero") }
        if compareMagnitude(a, b) < 0 { return ([], a) }
        if b.count == 1 {
            let (quotient, rest) = divideSmall(a, b[0])
            return (quotient, rest == 0 ? [] : [rest])
        }
        var quotient = [UInt32](repeating: 0, count: a.count)
        var rest: [UInt32] = []
        var bit = a.count * 32 - 1
        while bit >= 0 {
            rest = trimmed(shiftedUp(rest, (a[bit / 32] >> UInt32(bit % 32)) & 1))
            if compareMagnitude(rest, b) >= 0 {
                rest = subtractMagnitude(rest, b)
                quotient[bit / 32] |= UInt32(1) << UInt32(bit % 32)
            }
            bit -= 1
        }
        return (trimmed(quotient), rest)
    }

    static func parse(_ text: String) -> Any {
        var scalars = Array(text.unicodeScalars)
        var negative = false
        if let first = scalars.first, first == "-" || first == "+" {
            negative = first == "-"
            scalars.removeFirst()
        }
        if scalars.isEmpty { fatalError("defect: not an integer: \(text)") }
        var magnitude: [UInt32] = []
        for scalar in scalars {
            guard scalar.value >= 48 && scalar.value <= 57 else { fatalError("defect: not an integer: \(text)") }
            magnitude = multiplySmall(magnitude, 10, scalar.value - 48)
        }
        return make(negative, magnitude)
    }

    static func fromInt(_ value: Int) -> Any {
        let size = value.magnitude
        return make(value < 0, [UInt32(truncatingIfNeeded: size), UInt32(truncatingIfNeeded: size >> 32)])
    }

    static func text(_ value: Any) -> String {
        let number = big(value)
        if number.limbs.isEmpty { return "0" }
        var chunks: [UInt32] = []
        var rest = number.limbs
        while !rest.isEmpty {
            let (quotient, chunk) = divideSmall(rest, 1_000_000_000)
            chunks.append(chunk)
            rest = quotient
        }
        var out = number.negative ? "-" : ""
        out += String(chunks.last!)
        for chunk in chunks.dropLast().reversed() {
            let digits = String(chunk)
            out += String(repeating: "0", count: 9 - digits.count) + digits
        }
        return out
    }

    static func signed(_ negative: Bool, _ a: [UInt32], _ otherNegative: Bool, _ b: [UInt32]) -> TermBigInt {
        if negative == otherNegative { return make(negative, addMagnitude(a, b)) }
        let order = compareMagnitude(a, b)
        if order == 0 { return make(false, []) }
        return order > 0 ? make(negative, subtractMagnitude(a, b)) : make(otherNegative, subtractMagnitude(b, a))
    }

    static func add(_ a: Any, _ b: Any) -> Any {
        let (x, y) = (big(a), big(b))
        return signed(x.negative, x.limbs, y.negative, y.limbs)
    }

    static func subtract(_ a: Any, _ b: Any) -> Any {
        let (x, y) = (big(a), big(b))
        return signed(x.negative, x.limbs, !y.negative, y.limbs)
    }

    static func multiply(_ a: Any, _ b: Any) -> Any {
        let (x, y) = (big(a), big(b))
        return make(x.negative != y.negative, multiplyMagnitude(x.limbs, y.limbs))
    }

    static func divide(_ a: Any, _ b: Any) -> Any {
        let (x, y) = (big(a), big(b))
        return make(x.negative != y.negative, divideMagnitude(x.limbs, y.limbs).0)
    }

    static func remainder(_ a: Any, _ b: Any) -> Any {
        let (x, y) = (big(a), big(b))
        return make(x.negative, divideMagnitude(x.limbs, y.limbs).1)
    }

    static func negate(_ value: Any) -> Any {
        let x = big(value)
        return make(!x.negative, x.limbs)
    }

    static func compare(_ a: Any, _ b: Any) -> Int {
        let (x, y) = (big(a), big(b))
        if x.negative != y.negative { return x.negative ? -1 : 1 }
        let order = compareMagnitude(x.limbs, y.limbs)
        return x.negative ? -order : order
    }
}
