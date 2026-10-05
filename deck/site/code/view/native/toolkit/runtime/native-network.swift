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
