// The device traits on AppKit and UIKit (native-dom-0012), docked by ../device.tree as `<global:native-device>`.
//
// Nothing is cached as truth. `readTrait` asks the platform every time, and `recheck` reads every trait again and
// calls the handler for each one that differs from what it last reported. The platform's notifications only trigger a
// recheck. Reads the window through `nativeView` (dom/native/toolkit/runtime/native-view.swift), which a toolkit app
// always carries.

import Foundation

#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

enum nativeDevice {
    static let names = ["idiom", "width-class", "pointer", "color-scheme", "reduce-motion", "text-scale"]
    private static var handler: ((String, String) -> Void)?
    private static var last: [String: String] = [:]
    private static var observers: [NSObjectProtocol] = []
    #if canImport(AppKit)
    private static var appearance: NSKeyValueObservation?
    #endif

    static func readTrait(_ name: String) -> String {
        switch name {
        case "idiom": return idiom()
        case "width-class": return windowWidth() < 600 ? "compact" : "regular"
        case "pointer": return pointer()
        case "color-scheme": return dark() ? "dark" : "light"
        case "reduce-motion": return reduceMotion() ? "yes" : "no"
        case "text-scale": return textScale()
        default: return "no"
        }
    }

    static func watch(_ body: @escaping (String, String) -> Void) {
        handler = body
        for name in names {
            last[name] = readTrait(name)
        }
        if !observers.isEmpty {
            return
        }
        #if canImport(AppKit)
        appearance = NSApplication.shared.observe(\.effectiveAppearance) { _, _ in recheck() }
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { _ in recheck() })
        observers.append(NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification, object: nil, queue: .main
        ) { _ in recheck() })
        #endif
        #if canImport(UIKit)
        observers.append(NotificationCenter.default.addObserver(
            forName: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil, queue: .main
        ) { _ in recheck() })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIContentSizeCategory.didChangeNotification, object: nil, queue: .main
        ) { _ in recheck() })
        // the window's own trait changes. A trait asked for before launch (a style table follows the color scheme from
        // the first line of `main`, native-dom-0048) finds no window yet, so the watch waits for it rather than being
        // skipped, which lost every rotation that run
        if nativeView.window != nil {
            watchWindow()
        } else {
            nativeView.onWindow.append { watchWindow() }
        }
        #endif
    }

    #if canImport(UIKit)
    private static func watchWindow() {
        // every runtime call is on the main thread already (the program runs there), which the API cannot see
        if #available(iOS 17.0, *), let window = nativeView.window {
            MainActor.assumeIsolated {
                // the vertical size class too: an iPhone turned to landscape changes that one, and its width with it
                _ = window.registerForTraitChanges(
                    [UITraitUserInterfaceStyle.self, UITraitHorizontalSizeClass.self, UITraitVerticalSizeClass.self]
                ) {
                    (_: UIWindow, _: UITraitCollection) in recheck()
                }
            }
        }
        // what the window reads now may differ from what was read without it
        recheck()
    }
    #endif

    static func unwatch() {
        handler = nil
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
            #if canImport(AppKit)
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            #endif
        }
        observers = []
        #if canImport(AppKit)
        appearance = nil
        #endif
    }

    // read every trait again, and report each that the platform changed since the last report
    static func recheck() {
        guard let handler else {
            return
        }
        for name in names {
            let now = readTrait(name)
            if last[name] != now {
                last[name] = now
                handler(name, now)
            }
        }
    }

    static func changeTrait(_ name: String, _ value: String) {
        if name == "color-scheme" {
            #if canImport(AppKit)
            NSApplication.shared.appearance = NSAppearance(named: value == "dark" ? .darkAqua : .aqua)
            #endif
            #if canImport(UIKit)
            if let window = nativeView.window {
                window.overrideUserInterfaceStyle = value == "dark" ? .dark : .light
                if #available(iOS 17.0, *) {
                    window.updateTraitsIfNeeded()
                }
            }
            #endif
        }
        recheck()
    }

    // for tests: change the window's shape the way a person would, and let the platform report it (native-dom-0035)
    static func turn() {
        #if canImport(AppKit)
        if let window = nativeView.window {
            var frame = window.frame
            frame.size.width = 900
            window.setFrame(frame, display: true)
        }
        #endif
        #if canImport(UIKit)
        // to whichever shape the device is not in now: a simulator keeps the last orientation an app asked for, so a
        // turn that always asked for landscape found it already there on the next run
        if #available(iOS 16.0, *), let scene = nativeView.window?.windowScene {
            let wide = (nativeView.window?.bounds.width ?? 0) > (nativeView.window?.bounds.height ?? 0)
            MainActor.assumeIsolated {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: wide ? .portrait : .landscapeRight)) { error in
                    print("native-device turn refused: \(error.localizedDescription)")
                }
            }
        }
        #endif
    }

    private static func idiom() -> String {
        #if canImport(UIKit)
        switch UIDevice.current.userInterfaceIdiom {
        case .pad: return "tablet"
        case .tv: return "tv"
        case .mac: return "desktop"
        default: return "phone"
        }
        #else
        return "desktop"
        #endif
    }

    private static func pointer() -> String {
        #if canImport(UIKit)
        return UIDevice.current.userInterfaceIdiom == .mac ? "fine" : "touch"
        #else
        return "fine"
        #endif
    }

    private static func windowWidth() -> Double {
        #if canImport(AppKit)
        return Double(nativeView.window?.frame.width ?? NSScreen.main?.frame.width ?? 0)
        #else
        return Double(nativeView.window?.bounds.width ?? UIScreen.main.bounds.width)
        #endif
    }

    private static func dark() -> Bool {
        #if canImport(AppKit)
        return NSApplication.shared.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        #else
        let traits = nativeView.window?.traitCollection ?? UITraitCollection.current
        return traits.userInterfaceStyle == .dark
        #endif
    }

    private static func reduceMotion() -> Bool {
        #if canImport(AppKit)
        return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        #else
        return UIAccessibility.isReduceMotionEnabled
        #endif
    }

    // the body text size over its size at the default setting, to two places, `1` at the default
    private static func textScale() -> String {
        #if canImport(UIKit)
        let scale = UIFontMetrics(forTextStyle: .body).scaledValue(for: 17) / 17
        return format(Double(scale))
        #else
        return "1"
        #endif
    }

    private static func format(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
    }
}
