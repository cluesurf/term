// Machine facts for swift. The platform and architecture are named as node's `os.platform()` and `os.arch()` name
// them, so a program branches on one set of names. Reached only through the public machine API.
import Foundation

enum machine {
    static func cores() -> Int {
        max(1, Foundation.ProcessInfo.processInfo.activeProcessorCount)
    }

    static func platform() -> String {
        #if os(macOS) || os(iOS) || os(tvOS) || os(watchOS)
        return "darwin"
        #elseif os(Windows)
        return "win32"
        #else
        return "linux"
        #endif
    }

    static func architecture() -> String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x64"
        #elseif arch(i386)
        return "ia32"
        #else
        return "arm"
        #endif
    }
}
