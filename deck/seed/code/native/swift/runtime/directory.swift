// Working directory runtime. Reached only through the public environment API.
import Foundation

enum directory {
    static func get() -> String {
        FileManager.default.currentDirectoryPath
    }

    static func set(_ path: String) {
        FileManager.default.changeCurrentDirectoryPath(path)
    }
}
