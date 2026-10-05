// Vibration and haptics on AppKit and UIKit (device-layer-0006), docked by ../vibration.tree as
// `<global:native-vibration>`. The feedback generators on iOS (which a simulator accepts and does not play), and
// NSHapticFeedbackManager on macOS, which plays only on a Force Touch trackpad. Neither platform says whether anything
// was felt, so a played kind answers `played`.

import Foundation

#if canImport(UIKit)
import UIKit
#endif
#if canImport(AppKit)
import AppKit
#endif

enum nativeVibration {
    static let kinds = ["light", "medium", "heavy", "success", "warning", "error"]

    // `played`, or `unavailable` for a kind outside the set. On the main actor, where the feedback generators live
    @MainActor
    static func play(_ kind: String) async -> String {
        guard kinds.contains(kind) else { return "unavailable" }
        #if canImport(UIKit)
        switch kind {
        case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "heavy": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
        default: UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
        #else
        let pattern: NSHapticFeedbackManager.FeedbackPattern = kind == "light" ? .alignment : kind == "medium" ? .levelChange : .generic
        NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: .now)
        #endif
        return "played"
    }
}
