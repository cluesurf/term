// The clipboard on AppKit and UIKit (device-layer-0005), docked by ../clipboard.tree as `<global:native-clipboard>`.
// Plain text only: the general pasteboard every other app copies and pastes with.

import Foundation

#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

enum nativeClipboard {
    // the text on the clipboard now, or empty text when it holds none. Async in shape only, as the host tree awaits it
    // (Android's read waits for focus): a synchronous one drew swiftc's "no async operations occur within await"
    static func read() async -> String {
        #if canImport(AppKit)
        return NSPasteboard.general.string(forType: .string) ?? ""
        #else
        return UIPasteboard.general.string ?? ""
        #endif
    }

    // `written`, or `denied` when the pasteboard refused it
    static func write(_ text: String) -> String {
        #if canImport(AppKit)
        NSPasteboard.general.clearContents()
        return NSPasteboard.general.setString(text, forType: .string) ? "written" : "denied"
        #else
        UIPasteboard.general.string = text
        return "written"
        #endif
    }
}
