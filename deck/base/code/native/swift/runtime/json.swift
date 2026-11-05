import Foundation

// A JSON object or array is a REFERENCE here, as it is on TypeScript (a JS object) and Kotlin (a MutableMap): `setField`
// and `pushItem` write into the value they are given and hand it back. They copied a Swift Dictionary or Array on every
// write until 2026-10-02, which made building an object of n fields O(n^2) and, worse, left a value read through a second
// name unchanged where every other backend changed it. Parsed values are boxed the same way, so a parsed object can be
// written into, and `stringify` unboxes them for JSONSerialization.
final class JsonObject {
    var fields: [String: Any] = [:]
    var order: [String] = []
    func set(_ key: String, _ value: Any) {
        if fields.updateValue(value, forKey: key) == nil { order.append(key) }
    }
}

final class JsonArray {
    var items: [Any] = []
    init(_ items: [Any] = []) { self.items = items }
}

// Walks the text JSONSerialization already accepted, so an object's keys come out in the document's order. Foundation
// hands an object back as an unordered Dictionary, and the keys were sorted until item 0940, where TypeScript, Rust and
// Kotlin keep the document's order. Every value is still Foundation's own (NSNumber, CFBoolean, String, NSNull): the walk
// reads only where each member starts, and pairs it with the value Foundation parsed.
struct JsonOrder {
    let bytes: [UInt8]
    var at = 0

    mutating func space() {
        while at < bytes.count, bytes[at] == 0x20 || bytes[at] == 0x09 || bytes[at] == 0x0A || bytes[at] == 0x0D { at += 1 }
    }
    // past a string whose opening quote is at `at`, answering whether it held an escape
    mutating func skipText() -> Bool {
        var escaped = false
        at += 1
        while at < bytes.count, bytes[at] != 0x22 {
            if bytes[at] == 0x5C { escaped = true; at += 1 }
            at += 1
        }
        at += 1
        return escaped
    }
    // past any one value starting at `at`
    mutating func skip() {
        space()
        guard at < bytes.count else { return }
        let head = bytes[at]
        if head == 0x22 { _ = skipText(); return }
        if head == 0x7B || head == 0x5B {
            var depth = 0
            while at < bytes.count {
                let byte = bytes[at]
                if byte == 0x22 { _ = skipText(); continue }
                if byte == 0x7B || byte == 0x5B { depth += 1 }
                if byte == 0x7D || byte == 0x5D {
                    depth -= 1
                    if depth == 0 { at += 1; return }
                }
                at += 1
            }
            return
        }
        while at < bytes.count, ![0x2C, 0x7D, 0x5D, 0x20, 0x09, 0x0A, 0x0D].contains(bytes[at]) { at += 1 }
    }
    // the key whose quote is at `at`, decoded the way Foundation decoded it
    mutating func key() -> String {
        let start = at
        let escaped = skipText()
        if !escaped { return String(decoding: bytes[(start + 1)..<(at - 1)], as: UTF8.self) }
        let data = Data(bytes[start..<at])
        return (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) as? String ?? ""
    }
    // Foundation's value at `at` into boxes, an object's keys in the text's order
    mutating func box(_ value: Any) -> Any {
        space()
        if let dict = value as? [String: Any] {
            // each key at its first place with its last member's value, as JSON.parse keeps a repeated key. Foundation
            // keeps the first member's value, so a repeated key's last value is parsed again from its own text
            var order: [String] = []
            var last: [String: Range<Int>] = [:]
            var repeated: Set<String> = []
            at += 1
            space()
            while at < bytes.count, bytes[at] == 0x22 {
                let name = key()
                space()
                at += 1
                space()
                let start = at
                skip()
                if last.updateValue(start..<at, forKey: name) == nil { order.append(name) } else { repeated.insert(name) }
                space()
                if at < bytes.count, bytes[at] == 0x2C { at += 1; space() }
            }
            if at < bytes.count { at += 1 }
            let end = at
            let object = JsonObject()
            for name in order {
                let range = last[name]!
                if repeated.contains(name) {
                    let data = Data(bytes[range])
                    guard let field = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { continue }
                    var walk = JsonOrder(bytes: Array(data))
                    object.set(name, walk.box(field))
                    continue
                }
                guard let field = dict[name] else { continue }
                at = range.lowerBound
                object.set(name, box(field))
            }
            // a key the walk did not find keeps Foundation's value, after the rest
            for name in dict.keys.sorted() where object.fields[name] == nil { object.set(name, JsonOrder.plainBox(dict[name]!)) }
            at = end
            return object
        }
        if let array = value as? [Any] {
            at += 1
            var items: [Any] = []
            for item in array {
                space()
                items.append(box(item))
                space()
                if at < bytes.count, bytes[at] == 0x2C { at += 1 }
            }
            space()
            if at < bytes.count { at += 1 }
            return JsonArray(items)
        }
        skip()
        return value
    }
    // boxes with no text to read the order from
    static func plainBox(_ value: Any) -> Any {
        if let dict = value as? [String: Any] {
            let object = JsonObject()
            for key in dict.keys.sorted() { object.set(key, plainBox(dict[key]!)) }
            return object
        }
        if let array = value as? [Any] { return JsonArray(array.map(plainBox)) }
        return value
    }
}

enum json {
    // boxes back into what JSONSerialization writes
    static func plain(_ value: Any) -> Any {
        if let object = value as? JsonObject { return object.fields.mapValues(plain) }
        if let array = value as? JsonArray { return array.items.map(plain) }
        return value
    }
    static func parse(_ text: String) -> Any {
        guard let data = text.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return NSNull() }
        var walk = JsonOrder(bytes: Array(data))
        // a byte order mark Foundation reads past
        if walk.bytes.starts(with: [0xEF, 0xBB, 0xBF]) { walk.at = 3 }
        return walk.box(value)
    }
    static func stringify(_ value: Any) -> String {
        // a bare number spells the way JSON does everywhere else: the shortest digits that read back to the same
        // value (`6.8`, not the seventeen digits JSONSerialization writes), a whole one without a point
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            let double = number.doubleValue
            if double == double.rounded(), abs(double) < 1e15 { return String(Int(double)) }
            return String(double)
        }
        return written(value)
    }
    // an object is written in its own key order, as on TypeScript and Kotlin. Through a Swift Dictionary the order was
    // the hash's, which differs from one run to the next (`{"y":2,"x":"a"}` one run in two); each scalar and key is still
    // spelled by JSONSerialization, with a slash left plain as JSON.stringify writes it (`"a/b"`, never `"a\/b"`, item 0939)
    static func written(_ value: Any) -> String {
        if let object = value as? JsonObject {
            let parts = object.order.map { key in "\(written(key)):\(written(object.fields[key]!))" }
            return "{\(parts.joined(separator: ","))}"
        }
        if let array = value as? JsonArray { return "[\(array.items.map(written).joined(separator: ","))]" }
        guard let data = try? JSONSerialization.data(withJSONObject: plain(value), options: [.fragmentsAllowed, .withoutEscapingSlashes]) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func getField(_ value: Any, _ key: String) -> Any { return (value as? JsonObject)?.fields[key] ?? NSNull() }
    static func getItem(_ value: Any, _ index: Int) -> Any {
        guard let array = value as? JsonArray, index >= 0, index < array.items.count else { return NSNull() }
        return array.items[index]
    }
    static func asNumber(_ value: Any) -> Double { return (value as? NSNumber)?.doubleValue ?? 0 }
    static func asText(_ value: Any) -> String { return value as? String ?? "" }
    static func asBoolean(_ value: Any) -> Bool { return (value as? NSNumber)?.boolValue ?? false }
    static func isNull(_ value: Any) -> Bool { return value is NSNull }
    static func makeObject() -> Any { return JsonObject() }
    static func setField(_ value: Any, _ key: String, _ field: Any) -> Any {
        guard let object = value as? JsonObject else { return value }
        object.set(key, field)
        return object
    }
    static func makeArray() -> Any { return JsonArray() }
    static func pushItem(_ value: Any, _ item: Any) -> Any {
        guard let array = value as? JsonArray else { return value }
        array.items.append(item)
        return array
    }
    static func fromText(_ value: String) -> Any { return value }
    static func fromNumber(_ value: Double) -> Any { return value }
    static func fromBoolean(_ value: Bool) -> Any { return value }
    static func makeNull() -> Any { return NSNull() }
    // the shape questions: what a parsed value is, so a reader can walk it without guessing
    static func isArray(_ value: Any) -> Bool { return value is JsonArray }
    static func isObject(_ value: Any) -> Bool { return value is JsonObject }
    static func isText(_ value: Any) -> Bool { return value is String }
    static func isBoolean(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }
    static func arraySize(_ value: Any) -> Int { return (value as? JsonArray)?.items.count ?? 0 }
    static func arrayItem(_ value: Any, _ index: Int) -> Any { return getItem(value, index) }
    static func objectKeys(_ value: Any) -> [String] { return (value as? JsonObject)?.order ?? [] }
}
