// The network on AppKit and UIKit (device-layer-0010), docked by ../network.tree as `<global:native-network>`. One
// path from NWPathMonitor, the platform's own view of whether a route out exists and over what.

import Foundation
import Network

enum nativeNetwork {
    // `<online|offline> <kind>`, the kind wifi, cellular, wired, other or none
    static func read() async -> String {
        await withCheckedContinuation { continuation in
            let monitor = NWPathMonitor()
            let once = NetworkOnce()
            monitor.pathUpdateHandler = { path in
                // the handler can run again before `cancel` takes, on the monitor's queue: one answer, once
                guard once.claim() else { return }
                monitor.cancel()
                guard path.status == .satisfied else { return continuation.resume(returning: "offline none") }
                let kind = path.usesInterfaceType(.wifi) ? "wifi"
                    : path.usesInterfaceType(.cellular) ? "cellular"
                    : path.usesInterfaceType(.wiredEthernet) ? "wired" : "other"
                continuation.resume(returning: "online \(kind)")
            }
            monitor.start(queue: DispatchQueue(label: "term.network"))
        }
    }

    // every path NWPathMonitor reports, the current one first, to `handler` on the main thread, until `unwatch` is given
    // the number this answers. A path that reads the same as the last is not reported. Not isolated: the program may
    // call from any thread, so it enters the main actor itself (nativeWatch.enter)
    static func watch(_ handler: @escaping (String) -> Void) -> Int {
        nativeWatch.enter {
            nativeWatch.join("network", handler) { tell in
                let monitor = start(tell)
                return { monitor.cancel() }
            }
        }
    }

    static func unwatch(_ id: Int) {
        nativeWatch.enter { nativeWatch.leave("network", id) }
    }

    private static func start(_ handler: @escaping (String) -> Void) -> NWPathMonitor {
        let monitor = NWPathMonitor()
        var last = ""
        monitor.pathUpdateHandler = { path in
            let now = describe(path)
            DispatchQueue.main.async {
                guard now != last else { return }
                last = now
                handler(now)
            }
        }
        monitor.start(queue: DispatchQueue(label: "term.network.watch"))
        return monitor
    }

    private static func describe(_ path: NWPath) -> String {
        guard path.status == .satisfied else { return "offline none" }
        let kind = path.usesInterfaceType(.wifi) ? "wifi"
            : path.usesInterfaceType(.cellular) ? "cellular"
            : path.usesInterfaceType(.wiredEthernet) ? "wired" : "other"
        return "online \(kind)"
    }
}

// true the first time it is asked, and false every time after, from any thread
final class NetworkOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}
