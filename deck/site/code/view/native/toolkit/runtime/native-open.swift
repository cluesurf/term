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
        await present([text])
    }

    // the same for a file, offered as itself (a URL to a file is what AirDrop, Messages and Files take), or
    // unavailable when the path is not a file (beat-term-0003)
    @MainActor
    static func shareFile(_ path: String) async -> String {
        var folder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &folder), !folder.boolValue else { return "unavailable" }
        return await present([URL(fileURLWithPath: path)])
    }

    // the share sheet in front of everything, holding `items`, and `shown` only once it is up (nativePresent,
    // native-present.swift: UIKit drops a presentation asked while another is pending)
    @MainActor
    private static func present(_ items: [Any]) async -> String {
        #if canImport(UIKit)
        guard nativePresent.topmost() != nil else { return "unavailable" }
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        return await nativePresent.whenFree(sheet) ? "shown" : "unavailable"
        #else
        guard let view = (NSApp.keyWindow ?? NSApp.windows.first)?.contentView else { return "unavailable" }
        NSSharingServicePicker(items: items).show(relativeTo: .zero, of: view, preferredEdge: .minY)
        return "shown"
        #endif
    }
}
