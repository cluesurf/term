// Local notifications on AppKit and UIKit (device-layer-0007), docked by ../notification.tree as
// `<global:native-notification>`. UNUserNotificationCenter, delivered now (no trigger). A process with no bundle has no
// identity to notify as, and UserNotifications ends it, so it answers `unavailable` (nativePermission says the same).

import Foundation
import UserNotifications

enum nativeNotification {
    // shown, not-determined, denied, unavailable or failed
    static func post(_ title: String, _ body: String) async -> String {
        let grant = await nativePermission.status("notification")
        guard grant == "granted" else { return grant == "restricted" ? "denied" : grant }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        do {
            try await UNUserNotificationCenter.current().add(request)
            return "shown"
        } catch {
            return "failed"
        }
    }
}
