// Bitwise integer operations over swift (full 64-bit Int). Reached only through the public bit API.
enum bit {
    static func and(_ left: Int, _ right: Int) -> Int { return left & right }
    static func or(_ left: Int, _ right: Int) -> Int { return left | right }
    static func exclusiveOr(_ left: Int, _ right: Int) -> Int { return left ^ right }
    static func not(_ value: Int) -> Int { return ~value }
    static func shiftLeft(_ value: Int, _ count: Int) -> Int { return value << count }
    static func shiftRight(_ value: Int, _ count: Int) -> Int { return value >> count }
}
