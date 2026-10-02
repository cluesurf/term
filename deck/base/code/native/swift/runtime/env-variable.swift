// Environment variable runtime. Reached only through the public environment API.
import Foundation

enum envVariable {
    static func get(_ name: String) -> String {
        Foundation.ProcessInfo.processInfo.environment[name] ?? ""
    }

    static func set(_ name: String, _ value: String) {
        setenv(name, value, 1)
    }

    static func remove(_ name: String) {
        unsetenv(name)
    }

    // sorted by name, so a walk over the variables is the same on every run and every backend
    static func list() -> SeedMap<String, String> {
        SeedMap(pairs: Foundation.ProcessInfo.processInfo.environment.sorted { $0.key < $1.key }.map { ($0.key, $0.value) })
    }

    static func check(_ name: String) -> Bool {
        Foundation.ProcessInfo.processInfo.environment[name] != nil
    }
}
