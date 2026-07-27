import Foundation

enum json {
    static func parse(_ text: String) -> Any {
        guard let data = text.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return NSNull() }
        return value
    }
    static func stringify(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func getField(_ value: Any, _ key: String) -> Any { return (value as? [String: Any])?[key] ?? NSNull() }
    static func getItem(_ value: Any, _ index: Int) -> Any {
        guard let array = value as? [Any], index >= 0, index < array.count else { return NSNull() }
        return array[index]
    }
    static func asNumber(_ value: Any) -> Double { return (value as? NSNumber)?.doubleValue ?? 0 }
    static func asText(_ value: Any) -> String { return value as? String ?? "" }
    static func asBoolean(_ value: Any) -> Bool { return (value as? NSNumber)?.boolValue ?? false }
    static func isNull(_ value: Any) -> Bool { return value is NSNull }
    static func makeObject() -> Any { return [String: Any]() }
    static func setField(_ value: Any, _ key: String, _ field: Any) -> Any {
        var dict = (value as? [String: Any]) ?? [:]
        dict[key] = field
        return dict
    }
    static func makeArray() -> Any { return [Any]() }
    static func pushItem(_ value: Any, _ item: Any) -> Any {
        var items = (value as? [Any]) ?? []
        items.append(item)
        return items
    }
    static func fromText(_ value: String) -> Any { return value }
    static func fromNumber(_ value: Double) -> Any { return value }
    static func fromBoolean(_ value: Bool) -> Any { return value }
    static func makeNull() -> Any { return NSNull() }
}
