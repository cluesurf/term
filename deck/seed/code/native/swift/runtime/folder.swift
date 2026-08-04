// Standard user folders. Reached only through the public environment API. On Apple platforms these come from the
// documented search paths; the XDG fallbacks are kept for Swift builds on Linux, where those directories are the
// convention and `FileManager` returns nothing useful.
import Foundation

enum folder {
    private static func homeOrEmpty() -> String {
        NSHomeDirectory()
    }

    private static func xdgOr(_ variable: String, _ fallback: String) -> String {
        ProcessInfo.processInfo.environment[variable]
            ?? "\(homeOrEmpty())/\(fallback)"
    }

    private static func search(_ directory: FileManager.SearchPathDirectory) -> String? {
        FileManager.default
            .urls(for: directory, in: .userDomainMask)
            .first?
            .path
    }

    static func home() -> String {
        homeOrEmpty()
    }

    static func temporary() -> String {
        NSTemporaryDirectory()
    }

    static func data() -> String {
        #if canImport(Darwin)
            return search(.applicationSupportDirectory)
                ?? "\(homeOrEmpty())/Library/Application Support"
        #else
            return xdgOr("XDG_DATA_HOME", ".local/share")
        #endif
    }

    static func configuration() -> String {
        #if canImport(Darwin)
            return "\(homeOrEmpty())/Library/Preferences"
        #else
            return xdgOr("XDG_CONFIG_HOME", ".config")
        #endif
    }

    static func cache() -> String {
        #if canImport(Darwin)
            return search(.cachesDirectory)
                ?? "\(homeOrEmpty())/Library/Caches"
        #else
            return xdgOr("XDG_CACHE_HOME", ".cache")
        #endif
    }
}
