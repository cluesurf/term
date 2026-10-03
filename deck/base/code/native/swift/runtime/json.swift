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

enum json {
    // Foundation's parsed values into boxes, recursively
    static func box(_ value: Any) -> Any {
        if let dict = value as? [String: Any] {
            let object = JsonObject()
            for key in dict.keys.sorted() { object.set(key, box(dict[key]!)) }
            return object
        }
        if let array = value as? [Any] { return JsonArray(array.map(box)) }
        return value
    }
    // boxes back into what JSONSerialization writes
    static func plain(_ value: Any) -> Any {
        if let object = value as? JsonObject { return object.fields.mapValues(plain) }
        if let array = value as? JsonArray { return array.items.map(plain) }
        return value
    }
    static func parse(_ text: String) -> Any {
        guard let data = text.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return NSNull() }
        return box(value)
    }
    static func stringify(_ value: Any) -> String {
        // a bare number spells the way JSON does everywhere else: the shortest digits that read back to the same
        // value (`6.8`, not the seventeen digits JSONSerialization writes), a whole one without a point
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            let double = number.doubleValue
            if double == double.rounded(), abs(double) < 1e15 { return String(Int(double)) }
            return String(double)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: plain(value), options: [.fragmentsAllowed]) else { return "" }
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
