// Picking a file on AppKit and UIKit (beat-term-0002), docked by ../files.tree as `<global:native-files>`.
// iOS: UIDocumentPickerViewController asked for a COPY (`asCopy`), put in front by nativePresent (native-present.swift,
// which confirms it came up), its delegate kept alive until the person picks or cancels. macOS: an NSOpenPanel, run
// modally. Either way the file the person chose is copied into the app's temporary folder under a fresh folder,
// keeping its name, and that copy's path is answered, so the app reads a file of its own and never a location the
// picker lent it.

import Foundation
import UniformTypeIdentifiers

#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

enum nativeFiles {
    // the types a kind offers (../../../files.tree)
    static func types(_ kind: String) -> [UTType] {
        switch kind {
        case "audio": return [.audio]
        case "json": return [.json]
        default: return [.item]
        }
    }

    // `file <path>`, cancelled, or unavailable with no window to show the picker from
    @MainActor
    static func pick(_ kind: String) async -> String {
        #if canImport(UIKit)
        guard nativePresent.topmost() != nil else { return "unavailable" }
        // a picker that never came up is unavailable, never `cancelled`: nobody cancelled it
        guard let picked = await FilePicker().pick(types: types(kind)) else { return "unavailable" }
        guard let picked else { return "cancelled" }
        return keep(picked)
        #else
        let panel = NSOpenPanel()
        panel.allowedContentTypes = types(kind)
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let picked = panel.url else { return "cancelled" }
        return keep(picked)
        #endif
    }

    // the chosen file copied into a fresh folder in the app's temporary folder, keeping its name
    private static func keep(_ source: URL) -> String {
        let reading = source.startAccessingSecurityScopedResource()
        defer {
            if reading {
                source.stopAccessingSecurityScopedResource()
            }
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("picked-\(UUID().uuidString)")
        let copy = folder.appendingPathComponent(source.lastPathComponent)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: copy)
        } catch {
            return "cancelled"
        }
        return "file \(copy.path)"
    }
}

#if canImport(UIKit)
// one pick: the picker answers through its delegate, which UIKit holds weakly, so this holds itself until it answers
@MainActor
final class FilePicker: NSObject, UIDocumentPickerDelegate {
    private var answer: CheckedContinuation<URL?, Never>?
    private var keep: FilePicker?
    // a choice made before the wait began (a quick hand, between the picker coming up and the wait), kept for it
    private var early: URL??

    // nil when the picker never came up; `.some(nil)` when it was cancelled; else the file chosen
    func pick(types: [UTType]) async -> URL?? {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        keep = self
        guard await nativePresent.whenFree(picker) else {
            keep = nil
            return nil
        }
        if let early {
            keep = nil
            return .some(early)
        }
        let chosen: URL? = await withCheckedContinuation { continuation in
            answer = continuation
        }
        return .some(chosen)
    }

    private func finish(_ url: URL?) {
        guard let answer else {
            early = .some(url)
            return
        }
        answer.resume(returning: url)
        self.answer = nil
        keep = nil
    }

    nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        MainActor.assumeIsolated { finish(urls.first) }
    }

    nonisolated func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        MainActor.assumeIsolated { finish(nil) }
    }
}
#endif
