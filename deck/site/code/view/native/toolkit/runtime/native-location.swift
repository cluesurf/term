// Location on AppKit and UIKit (device-layer-0004), docked by ../location.tree as `<global:native-location>`.
// CoreLocation, once: a grant first (read through nativePermission, docked beside this), then one `requestLocation`,
// answered through the delegate.

import CoreLocation
import Foundation

enum nativeLocation {
    // `<latitude> <longitude> <accuracy>`, or not-determined, denied, unavailable or failed. On the main actor: a
    // CLLocationManager answers on the run loop of the thread that made it, and the main thread's is the one that runs
    @MainActor
    static func position() async -> String {
        let grant = await nativePermission.status("location")
        guard grant == "granted" else { return grant == "restricted" ? "denied" : grant }
        return await PositionReader().read()
    }
}

// one position: CoreLocation answers through the delegate, and the manager must live until it has
final class PositionReader: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var answer: CheckedContinuation<String, Never>?

    func read() async -> String {
        await withCheckedContinuation { continuation in
            answer = continuation
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyBest
            manager.requestLocation()
        }
    }

    private func finish(_ text: String) {
        guard let answer else { return }
        self.answer = nil
        answer.resume(returning: text)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let at = locations.last else { return finish("failed") }
        finish(String(format: "%.6f %.6f %.0f", at.coordinate.latitude, at.coordinate.longitude, at.horizontalAccuracy))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish((error as? CLError)?.code == .denied ? "denied" : "failed")
    }
}
