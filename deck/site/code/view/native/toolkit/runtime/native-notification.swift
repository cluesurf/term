// Local notifications on AppKit and UIKit (device-layer-0007), docked by ../notification.tree as
// `<global:native-notification>`. UNUserNotificationCenter, delivered now (no trigger). A process with no bundle has no
// identity to notify as, and UserNotifications ends it, so it answers `unavailable` (nativePermission says the same).

import Foundation
import UserNotifications

// the notification grant, brought by notifications (native-permission.swift), run when the program starts. It needs a
// bundle and no usage string
nativePermission.register(
    "notification",
    declaration: nil,
    status: { await nativeNotification.grant() },
    request: {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        return await nativeNotification.grant()
    }
)

enum nativeNotification {
    // the center's status as a grant, or unavailable with no bundle to notify as
    static func grant() async -> String {
        guard nativePermission.bundled else { return "unavailable" }
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "not-determined"
        @unknown default: return "unavailable"
        }
    }

    // kept for the life of the process: the center holds its delegate weakly
    private static let presenter = NotificationPresenter()

    // shown, not-determined, denied, unavailable or failed
    static func post(_ title: String, _ body: String) async -> String {
        let grant = await nativePermission.status("notification")
        guard grant == "granted" else { return grant == "restricted" ? "denied" : grant }
        // A notification posted while the app is in front is not shown unless a delegate asks for it, so without this
        // `shown` answered for a banner nobody saw. An app that set its own delegate keeps it
        let center = UNUserNotificationCenter.current()
        if center.delegate == nil {
            center.delegate = presenter
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        do {
            try await center.add(request)
            return "shown"
        } catch {
            return "failed"
        }
    }
}

// shows a notification as a banner, in the list and with its sound while the app is in front, as it would be with the
// app away. Holds no state, so it is safe to share across threads
final class NotificationPresenter: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }
}
