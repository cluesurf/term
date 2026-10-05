// Permissions on AppKit and UIKit (device-layer-0001), docked by ../permission.tree as `<global:native-permission>`.
//
// Each status is the platform's own, read when asked: AVCaptureDevice for the camera, CLLocationManager for location,
// UNUserNotificationCenter for notifications.
//
// ASKING NEEDS A DECLARATION. iOS and macOS end a process that requests a privacy grant without the usage string its
// Info.plist must carry (NSCameraUsageDescription, NSLocationWhenInUseUsageDescription), and UserNotifications ends a
// process with no bundle at all. So a request is made only when the declaration is there, and otherwise answers the
// status as it stands, without a prompt. The build writes the declarations for what an app reaches (device-layer-0012).

import AVFoundation
import CoreLocation
import Foundation
import UserNotifications

enum nativePermission {
    // the usage string a grant's prompt needs, by name
    private static let declarations = ["camera": "NSCameraUsageDescription", "location": "NSLocationWhenInUseUsageDescription"]

    // the process has a bundle, so the platform has an identity to hold a grant for
    private static var bundled: Bool { Bundle.main.bundleIdentifier != nil }

    private static func declared(_ name: String) -> Bool {
        guard let key = declarations[name] else { return bundled }
        return bundled && Bundle.main.object(forInfoDictionaryKey: key) != nil
    }

    static func status(_ name: String) async -> String {
        switch name {
        case "camera": return cameraStatus()
        case "location": return locationStatus(CLLocationManager().authorizationStatus)
        case "notification": return await notificationStatus()
        default: return "unavailable"
        }
    }

    static func request(_ name: String) async -> String {
        guard declared(name) else { return await status(name) }
        switch name {
        case "camera":
            _ = await AVCaptureDevice.requestAccess(for: .video)
            return cameraStatus()
        case "location":
            return await askLocation()
        case "notification":
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            return await notificationStatus()
        default:
            return "unavailable"
        }
    }

    // on the main actor: a CLLocationManager answers on the run loop of the thread that made it
    @MainActor
    private static func askLocation() async -> String {
        await LocationAsker().ask()
    }

    private static func cameraStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not-determined"
        @unknown default: return "unavailable"
        }
    }

    static func locationStatus(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "not-determined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .authorizedAlways: return "granted"
        #if canImport(UIKit)
        case .authorizedWhenInUse: return "granted"
        #endif
        @unknown default: return "granted"
        }
    }

    private static func notificationStatus() async -> String {
        guard bundled else { return "unavailable" }
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "not-determined"
        @unknown default: return "unavailable"
        }
    }
}

// One location grant request: CoreLocation answers through its delegate once the person has chosen, and the manager
// must live until then
final class LocationAsker: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var answer: CheckedContinuation<String, Never>?

    func ask() async -> String {
        if manager.authorizationStatus != .notDetermined {
            return nativePermission.locationStatus(manager.authorizationStatus)
        }
        return await withCheckedContinuation { continuation in
            answer = continuation
            manager.delegate = self
            #if canImport(UIKit)
            manager.requestWhenInUseAuthorization()
            #else
            manager.requestAlwaysAuthorization()
            #endif
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager.authorizationStatus != .notDetermined, let answer else { return }
        self.answer = nil
        answer.resume(returning: nativePermission.locationStatus(manager.authorizationStatus))
    }
}
