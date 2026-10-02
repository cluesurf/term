import Foundation

// Path manipulation over Foundation's NSString path APIs. The file extension carries its leading dot.
enum path {
    static func join(_ base: String, _ name: String) -> String {
        return (base as NSString).appendingPathComponent(name)
    }
    static func directory(_ target: String) -> String {
        return (target as NSString).deletingLastPathComponent
    }
    static func fileName(_ target: String) -> String {
        return (target as NSString).lastPathComponent
    }
    static func fileExtension(_ target: String) -> String {
        let value = (target as NSString).pathExtension
        return value.isEmpty ? "" : "." + value
    }
    static func isAbsolute(_ target: String) -> Bool {
        return (target as NSString).isAbsolutePath
    }
}
