import Foundation

// The one regex primitive over NSRegularExpression (ICU). The pattern arrives in the canonical dialect
// (base/code/regex/dialect.tree); this runs it without anchoring bounds, so ^ and \z mean the ends of the whole text
// whatever position the search starts from, and turns UTF-16 offsets into code point offsets.
enum regex {
    static var compiled: [String: NSRegularExpression] = [:]

    static func search(_ pattern: String, _ text: String, _ from: Int) -> [Int] {
        let engine: NSRegularExpression
        if let found = compiled[pattern] {
            engine = found
        } else {
            guard let made = try? NSRegularExpression(pattern: pattern) else { return [] }
            compiled[pattern] = made
            engine = made
        }
        let scalars = Array(text.unicodeScalars)
        if from < 0 || from > scalars.count { return [] }
        var unit = 0
        for k in 0..<from { unit += scalars[k].value > 0xFFFF ? 2 : 1 }
        let length = text.utf16.count
        guard let found = engine.firstMatch(in: text, options: [.withoutAnchoringBounds], range: NSRange(location: unit, length: length - unit)) else {
            return []
        }
        func toPoint(_ at: Int) -> Int {
            var u = unit
            var p = from
            while u < at {
                u += scalars[p].value > 0xFFFF ? 2 : 1
                p += 1
            }
            return p
        }
        var out: [Int] = []
        for group in 0..<found.numberOfRanges {
            let span = found.range(at: group)
            if span.location == NSNotFound {
                out.append(-1)
                out.append(-1)
            } else {
                out.append(toPoint(span.location))
                out.append(toPoint(span.location + span.length))
            }
        }
        return out
    }
}
