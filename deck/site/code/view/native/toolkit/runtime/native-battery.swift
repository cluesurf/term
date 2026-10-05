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

    private static var observers: [NSObjectProtocol] = []
    private static var handler: ((String) -> Void)?
    private static var last = ""
    #if os(macOS)
    private static var source: CFRunLoopSource?
    #endif

    // the battery now, and again at every change the platform reports (UIDevice's notifications on iOS, a power-source
    // run loop source on macOS), to `handler` on the main thread, until `unwatch` is given the number this answers. A
    // change that reads the same is not reported. Not isolated: the program may call from any thread, so it enters the
    // main actor itself (nativeWatch.enter)
    static func watch(_ handler: @escaping (String) -> Void) -> Int {
        nativeWatch.enter {
            nativeWatch.join("battery", handler) { tell in
                start(tell)
                return { stop() }
            }
        }
    }

    static func unwatch(_ id: Int) {
        nativeWatch.enter { nativeWatch.leave("battery", id) }
    }

    @MainActor
    private static func start(_ body: @escaping (String) -> Void) {
        handler = body
        report()
        #if canImport(UIKit)
        for name in [UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { report() }
            })
        }
        #elseif os(macOS)
        if let made = IOPSNotificationCreateRunLoopSource({ _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { nativeBattery.report() } }
        }, nil)?.takeRetainedValue() {
            source = made
            CFRunLoopAddSource(CFRunLoopGetMain(), made, .defaultMode)
        }
        #endif
    }

    @MainActor
    private static func stop() {
        handler = nil
        last = ""
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers = []
        #if os(macOS)
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .defaultMode)
        }
        source = nil
        #endif
    }

    // read again, and tell the handler when it differs from the last report
    @MainActor
    private static func report() {
        Task { @MainActor in
            let now = await read()
            guard now != last, let handler else { return }
            last = now
            handler(now)
        }
    }

    private static func level(_ value: Double) -> String {
        String(format: "%.2f", min(1, max(0, value)))
    }
}
