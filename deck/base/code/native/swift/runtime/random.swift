enum random {
    static func number() -> Int { return 0 }
    static func integer(_ low: Int, _ high: Int) -> Int { return Int.random(in: low...high) }
}
