import Foundation

enum console {
    static func writeLine(_ message: String) { print(message) }
    static func writeError(_ message: String) { FileHandle.standardError.write((message + "\n").data(using: .utf8)!) }
}
