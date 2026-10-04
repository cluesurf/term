// Where the app has been, kept across a relaunch, on AppKit and UIKit (live reload, ../address.tree). The address is
// the TERM_DEV_ADDRESS environment variable, which `term work` sets for the app it launches (the simulator passes a
// SIMCTL_CHILD_ variable through to the app the same way); without it nothing is read or written.
import Foundation

enum nativeAddress {
    private static let file: String? = ProcessInfo.processInfo.environment["TERM_DEV_ADDRESS"].flatMap { $0.isEmpty ? nil : $0 }

    // the history the run before this one kept, one path a line, or empty text
    static func read() -> String {
        guard let file, let text = try? String(contentsOfFile: file, encoding: .utf8) else { return "" }
        return text
    }

    static func write(_ text: String) {
        guard let file else { return }
        try? text.write(toFile: file, atomically: true, encoding: .utf8)
    }
}
