// Environment variable runtime. Reached only through the public environment API.
import Foundation

enum variable {
    static func get(_ name: String) -> String {
        ProcessInfo.processInfo.environment[name] ?? ""
    }

    static func set(_ name: String, _ value: String) {
        setenv(name, value, 1)
    }

    static func remove(_ name: String) {
        unsetenv(name)
    }

    static func list() -> SeedMap<String, String> {
        SeedMap(ProcessInfo.processInfo.environment)
    }

    static func check(_ name: String) -> Bool {
        ProcessInfo.processInfo.environment[name] != nil
    }
}
