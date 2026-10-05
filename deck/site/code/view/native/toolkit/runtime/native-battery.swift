// The battery on AppKit and UIKit (device-layer-0009), docked by ../battery.tree as `<global:native-battery>`. UIDevice
// on iOS (monitoring turned on to read it), and the power sources on macOS (IOKit), where a Mac with no battery has
// none to report.

import Foundation

#if canImport(UIKit)
import UIKit
#endif
#if os(macOS)
import IOKit.ps
#endif

enum nativeBattery {
    // `<level> <state>`, or unavailable. On the main actor, where UIDevice is read
    @MainActor
    static func read() async -> String {
        #if canImport(UIKit)
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        // the simulator, and a device before its first reading, report a level below zero and an unknown state
        guard device.batteryLevel >= 0 else { return "unavailable" }
        let state: String
        switch device.batteryState {
        case .charging: state = "charging"
        case .full: state = "full"
        case .unplugged: state = "unplugged"
        default: state = "unknown"
        }
        return "\(level(Double(device.batteryLevel))) \(state)"
        #elseif os(macOS)
        let info = IOPSCopyPowerSourcesInfo().takeRetainedValue()
        let sources = IOPSCopyPowerSourcesList(info).takeRetainedValue() as [CFTypeRef]
        for source in sources {
            guard let found = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
                  found[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
                  let current = found[kIOPSCurrentCapacityKey] as? Int,
                  let most = found[kIOPSMaxCapacityKey] as? Int, most > 0
            else { continue }
            let charging = found[kIOPSIsChargingKey] as? Bool ?? false
            let charged = found[kIOPSIsChargedKey] as? Bool ?? false
            let plugged = found[kIOPSPowerSourceStateKey] as? String == kIOPSACPowerValue
            // plugged in and not charging (the Mac holding the charge short of full) is neither full nor charging
            let state = charged ? "full" : charging ? "charging" : plugged ? "unknown" : "unplugged"
            return "\(level(Double(current) / Double(most))) \(state)"
        }
        return "unavailable"
        #else
        return "unavailable"
        #endif
    }

    private static func level(_ value: Double) -> String {
        String(format: "%.2f", min(1, max(0, value)))
    }
}
