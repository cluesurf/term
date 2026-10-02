// Runtime shape checks. The type system cannot answer these, so they are a platform capability like any other:
// the host is asked what a value actually is. Reached only through the public shape API.
import Foundation

enum shape {
    static func isList(_ value: Any?) -> Bool {
        value is [Any]
    }

    static func isText(_ value: Any?) -> Bool {
        value is String
    }

    static func isNull(_ value: Any?) -> Bool {
        value == nil
    }

    static func typeOf(_ value: Any?) -> String {
        switch value {
        case nil: return "null"
        case is [Any]: return "list"
        case is String: return "text"
        case is Bool: return "boolean"
        case is Int, is Double: return "number"
        default: return "object"
        }
    }
    static func isPresent(_ value: Any?) -> Bool { value != nil }
}
