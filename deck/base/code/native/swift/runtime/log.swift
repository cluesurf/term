import Foundation

enum log {
    static func writeInfo(_ message: String) { print(message) }
    static func writeWarn(_ message: String) { print(message) }
    static func writeError(_ message: String) { FileHandle.standardError.write((message + "\n").data(using: .utf8)!) }
    static func writeDebug(_ message: String) { print(message) }
}
