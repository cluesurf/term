// Deep structural equality over Any: identical scalars are equal, two dynamic lists are equal when their
// sizes match and every element pair is deep-equal, and anything else answers false.
enum compareRuntime {
    static func deepEqual(_ a: Any, _ b: Any) -> Bool {
        if let x = a as? String, let y = b as? String { return x == y }
        if let x = a as? Int, let y = b as? Int { return x == y }
        if let x = a as? Double, let y = b as? Double { return x == y }
        if let x = a as? Bool, let y = b as? Bool { return x == y }
        if a is Void && b is Void { return true }

        if let x = a as? SeedList<Any>, let y = b as? SeedList<Any> {
            if x.data.count != y.data.count { return false }

            for i in 0..<x.data.count {
                if !deepEqual(x.data[i], y.data[i]) { return false }
            }

            return true
        }

        if let x = a as? SeedList<String>, let y = b as? SeedList<String> { return x.data == y.data }
        if let x = a as? SeedList<Int>, let y = b as? SeedList<Int> { return x.data == y.data }

        return false
    }

    static func numeric(_ v: Any) -> Double {
        if let n = v as? Int { return Double(n) }
        if let n = v as? Double { return n }
        return Double.nan
    }

    static func contains(_ list: Any, _ value: Any) -> Bool {
        guard let items = list as? SeedList<Any> else { return false }

        for item in items.data {
            if deepEqual(item, value) { return true }
        }

        return false
    }

    static func asText(_ v: Any) -> String {
        (v as? String) ?? ""
    }

    static func isTruthy(_ v: Any) -> Bool {
        if let b = v as? Bool { return b }
        if let n = v as? Int { return n != 0 }
        if let n = v as? Double { return n != 0 }
        if let s = v as? String { return !s.isEmpty }
        return !(v is Void)
    }

    static func above(_ a: Any, _ b: Any) -> Bool {
        numeric(a) > numeric(b)
    }

    static func below(_ a: Any, _ b: Any) -> Bool {
        numeric(a) < numeric(b)
    }

    static func gap(_ a: Any, _ b: Any) -> Double {
        abs(numeric(a) - numeric(b))
    }
}
