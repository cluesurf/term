import Foundation

enum console {
    // the text as given, flushed: stdout is buffered, and a prompt has no newline to flush it
    static func writeText(_ message: String) { print(message, terminator: ""); fflush(stdout) }
    static func writeLine(_ message: String) { print(message) }
    static func writeError(_ message: String) { FileHandle.standardError.write((message + "\n").data(using: .utf8)!) }
}
