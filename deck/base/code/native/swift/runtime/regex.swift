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

    // every match left to right, none overlapping, in one pass: the width of one match's slots first (two per group,
    // group 0 the whole match), then each match's slots in code points. After an empty match the search moves on one
    // code point, as the Term search does, so every engine iterates alike.
    static func searchAll(_ pattern: String, _ text: String) -> [Int] {
        var out: [Int] = [-1]
        let engine: NSRegularExpression
        if let found = compiled[pattern] {
            engine = found
        } else {
            guard let made = try? NSRegularExpression(pattern: pattern) else { return out }
            compiled[pattern] = made
            engine = made
        }
        let scalars = Array(text.unicodeScalars)
        let length = text.utf16.count
        // a cursor: the code point count at a UTF-16 offset, moved forwards only
        var cursorUnit = 0
        var cursorPoint = 0
        func pointAt(_ at: Int, _ fromUnit: Int, _ fromPoint: Int) -> Int {
            var u = fromUnit
            var p = fromPoint
            while u < at && p < scalars.count {
                u += scalars[p].value > 0xFFFF ? 2 : 1
                p += 1
            }
            return p
        }
        var unit = 0
        while unit <= length {
            guard let found = engine.firstMatch(in: text, options: [.withoutAnchoringBounds], range: NSRange(location: unit, length: length - unit)) else {
                break
            }
            let whole = found.range(at: 0)
            let startPoint = pointAt(whole.location, cursorUnit, cursorPoint)
            cursorUnit = whole.location
            cursorPoint = startPoint
            out[0] = found.numberOfRanges * 2
            for group in 0..<found.numberOfRanges {
                let span = found.range(at: group)
                if span.location == NSNotFound {
                    out.append(-1)
                    out.append(-1)
                } else {
                    out.append(pointAt(span.location, whole.location, startPoint))
                    out.append(pointAt(span.location + span.length, whole.location, startPoint))
                }
            }
            let end = whole.location + whole.length
            if whole.length > 0 {
                unit = end
            } else {
                let next = pointAt(end, whole.location, startPoint)
                unit = end + (next < scalars.count && scalars[next].value > 0xFFFF ? 2 : 1)
            }
        }
        return out
    }
}
