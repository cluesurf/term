// Motion on AppKit and UIKit (device-layer-0011), docked by ../motion.tree as `<global:native-motion>`. One
// accelerometer sample through CoreMotion on iOS, in metres per second squared as Android and the web report it
// (CoreMotion reports g). A Mac and the iOS simulator have no accelerometer.

import Foundation

#if canImport(UIKit)
import CoreMotion
#endif

enum nativeMotion {
    // standard gravity, CoreMotion's unit
    private static let gravity = 9.80665

    #if canImport(UIKit)
    private static let manager = CMMotionManager()
    #endif

    // `<x> <y> <z>`, or unavailable
    static func sample() async -> String {
        #if canImport(UIKit)
        guard manager.isAccelerometerAvailable else { return "unavailable" }
        return await withCheckedContinuation { continuation in
            var answered = false
            manager.accelerometerUpdateInterval = 0.05
            manager.startAccelerometerUpdates(to: .main) { data, _ in
                guard !answered, let data else { return }
                answered = true
                manager.stopAccelerometerUpdates()
                let a = data.acceleration
                continuation.resume(returning: String(format: "%.2f %.2f %.2f", a.x * gravity, a.y * gravity, a.z * gravity))
            }
        }
        #else
        return "unavailable"
        #endif
    }
}
