// Bitwise integer operations over swift (full 64-bit Int). Reached only through the public bit API.
enum bit {
    static func and(_ left: Int, _ right: Int) -> Int { return left & right }
    static func or(_ left: Int, _ right: Int) -> Int { return left | right }
    static func exclusiveOr(_ left: Int, _ right: Int) -> Int { return left ^ right }
    static func not(_ value: Int) -> Int { return ~value }
    static func shiftLeft(_ value: Int, _ count: Int) -> Int { return value << count }
    static func shiftRight(_ value: Int, _ count: Int) -> Int { return value >> count }
    static func shiftRightUnsigned(_ value: Int, _ count: Int) -> Int { return Int(bitPattern: UInt(bitPattern: value) >> UInt(count)) }
    // A SIGNED 32-BIT MULTIPLY WITH WRAPAROUND, `Math.imul` semantics: the high bits are DISCARDED, which is
    // what the classic string hashes are defined in terms of. A 64-bit product would give a different number.
    static func multiply32(_ left: Int, _ right: Int) -> Int { return Int(Int32(truncatingIfNeeded: left) &* Int32(truncatingIfNeeded: right)) }
}
