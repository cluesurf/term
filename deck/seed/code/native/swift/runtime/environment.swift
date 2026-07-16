import Foundation

enum environment {
    static func currentDirectory() -> String { return FileManager.default.currentDirectoryPath }
    static func getVariable(_ name: String) -> String { return ProcessInfo.processInfo.environment[name] ?? "" }
}
