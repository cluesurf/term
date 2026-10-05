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

    // every position CoreLocation reports, the current one first, to `handler` on the main thread, until `unwatch` is
    // given the number this answers. Without the grant the handler hears the grant's status once. Not isolated: the
    // program may call from any thread, so it enters the main actor itself (nativeWatch.enter)
    static func watch(_ handler: @escaping (String) -> Void) -> Int {
        nativeWatch.enter {
            nativeWatch.join("position", handler) { tell in
                let grant = locationGrant()
                guard grant == "granted" else {
                    tell(grant)
                    return {}
                }
                let follower = PositionFollower(tell)
                return { follower.stop() }
            }
        }
    }

    static func unwatch(_ id: Int) {
        nativeWatch.enter { nativeWatch.leave("position", id) }
    }

    // the grant as nativePermission reads it, without waiting: a watch starts at once
    private static func locationGrant() -> String {
        let status = nativePermission.locationStatus(CLLocationManager().authorizationStatus)
        return status == "restricted" ? "denied" : status
    }
}

// a running position watch, until it is stopped
final class PositionFollower: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let handler: (String) -> Void

    init(_ handler: @escaping (String) -> Void) {
        self.handler = handler
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.startUpdatingLocation()
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.delegate = nil
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let at = locations.last else { return }
        handler(String(format: "%.6f %.6f %.0f", at.coordinate.latitude, at.coordinate.longitude, at.horizontalAccuracy))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .denied {
            handler("denied")
        }
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
