// Handing things to the platform on AppKit and UIKit (device-layer-0008), docked by ../open.tree as
// `<global:native-open>`. An address goes to whatever app handles it (UIApplication.open, NSWorkspace.open); text goes
// to the share sheet (UIActivityViewController, NSSharingServicePicker), shown from the app's key window, asked of the
// application rather than of a host, so a cask (a WebView app) links this as a toolkit app does (device-layer-0013).

import Foundation

#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

enum nativeOpen {
    // opened, or unavailable when nothing handles the address (or it is not one)
    @MainActor
    static func address(_ address: String) async -> String {
        guard let url = URL(string: address), url.scheme != nil else { return "unavailable" }
        #if canImport(UIKit)
        return await UIApplication.shared.open(url) ? "opened" : "unavailable"
        #else
        // a scheme no app claims would open nothing, and asking first keeps NSWorkspace from offering to find one
        guard NSWorkspace.shared.urlForApplication(toOpen: url) != nil else { return "unavailable" }
        return NSWorkspace.shared.open(url) ? "opened" : "unavailable"
        #endif
    }

    // shown, or unavailable with no window to show the sheet from. On the main actor, where every view lives
    @MainActor
    static func share(_ text: String) async -> String {
        #if canImport(UIKit)
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first, let root = window.rootViewController else { return "unavailable" }
        let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        // an iPad shows the sheet as a popover, which must say what it points at
        sheet.popoverPresentationController?.sourceView = window
        sheet.popoverPresentationController?.sourceRect = CGRect(x: window.bounds.midX, y: window.bounds.midY, width: 1, height: 1)
        root.present(sheet, animated: true)
        return "shown"
        #else
        guard let view = (NSApp.keyWindow ?? NSApp.windows.first)?.contentView else { return "unavailable" }
        NSSharingServicePicker(items: [text]).show(relativeTo: .zero, of: view, preferredEdge: .minY)
        return "shown"
        #endif
    }
}
