enum random {
    static func number() -> Double { return Double.random(in: 0..<1) }
    static func integer(_ low: Int, _ high: Int) -> Int { return Int.random(in: low...high) }
}
