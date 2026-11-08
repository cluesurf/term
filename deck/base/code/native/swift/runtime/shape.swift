// Runtime shape checks. The type system cannot answer these, so they are a platform capability like any other:
// the host is asked what a value actually is. Reached only through the public shape API.
import Foundation

enum shape {
    // A Term list is the prelude's generic `SeedList<T>`, which no `is` test names for every T, so it is told by its
    // type's name. isList answered false for every Term list before (item term-self-host-001-1091).
    static func isList(_ value: Any?) -> Bool {
        guard let v = value else { return false }
        return v is [Any] || String(describing: type(of: v)).hasPrefix("SeedList<")
    }

    // the same answer as typeOf's `number`, on every backend (item term-self-host-001-1091)
    static func isNumber(_ value: Any?) -> Bool {
        !(value is Bool) && (value is Int || value is Double)
    }

    static func isText(_ value: Any?) -> Bool {
        value is String
    }

    static func isNull(_ value: Any?) -> Bool {
        value == nil
    }

    // Term's words, the same on every backend: `null`, `list`, `text`, `boolean`, `number` or `object` (item
    // term-self-host-001-1089). A Term list is the prelude's generic `SeedList<T>`, which no `is` test names for
    // every T, so it is told by its type's name (isList): it answered `object` before.
    static func typeOf(_ value: Any?) -> String {
        if value == nil { return "null" }
        if isList(value) { return "list" }
        switch value {
        case is String: return "text"
        case is Bool: return "boolean"
        case is Int, is Double: return "number"
        default: return "object"
        }
    }
    static func isPresent(_ value: Any?) -> Bool { value != nil }
}
