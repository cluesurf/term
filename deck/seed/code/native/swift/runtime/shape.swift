// Runtime shape checks. The type system cannot answer these, so they are a platform capability like any other:
// the host is asked what a value actually is. Reached only through the public shape API.
import Foundation

enum shape {
    static func isList(_ value: Any?) -> Bool {
        value is [Any]
    }
}
