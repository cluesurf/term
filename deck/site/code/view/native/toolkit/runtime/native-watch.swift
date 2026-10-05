// The watchers' fan-out on AppKit and UIKit (device-layer-0016), docked as `<global:native-watch>` by every host tree
// whose capability can be watched. Many handlers share one platform subscription per capability: the first watch starts
// it, the last drop stops it, and a watch made while it runs hears the last answer at once, so every handler is told the
// current value first. Everything here runs on the main thread, where every capability delivers.

import Foundation

@MainActor
enum nativeWatch {
    private final class Topic {
        var handlers: [Int: (String) -> Void] = [:]
        var last: String?
        var stop: () -> Void = {}
    }

    private static var topics: [String: Topic] = [:]
    private static var next = 0

    // `body` on the main actor, from any thread, as the toolkit host's own `onMain` does: a program's async code (a
    // `launch` body) runs on the global executor, and its watch must still start on the main thread
    nonisolated static func enter<T: Sendable>(_ body: @MainActor () -> T) -> T {
        Thread.isMainThread ? MainActor.assumeIsolated(body) : DispatchQueue.main.sync { MainActor.assumeIsolated(body) }
    }

    // `handler` added to the capability `name`, and the number that removes it. `start` begins the platform's
    // subscription with the function every answer goes through, and answers the function that ends it
    static func join(_ name: String, _ handler: @escaping (String) -> Void, start: (@escaping (String) -> Void) -> () -> Void) -> Int {
        next += 1
        let id = next
        let topic = topics[name] ?? Topic()
        topics[name] = topic
        topic.handlers[id] = handler

        guard topic.handlers.count == 1 else {
            if let last = topic.last {
                handler(last)
            }
            return id
        }

        let stop = start { value in
            topic.last = value
            // in the order they joined, and over a copy: a handler may drop itself, or another, as it is told
            for key in topic.handlers.keys.sorted() {
                topic.handlers[key]?(value)
            }
        }

        // a handler told at once may have dropped itself before the subscription's end was known
        if topics[name] === topic {
            topic.stop = stop
        } else {
            stop()
        }
        return id
    }

    static func leave(_ name: String, _ id: Int) {
        guard let topic = topics[name], topic.handlers.removeValue(forKey: id) != nil, topic.handlers.isEmpty else { return }
        topics[name] = nil
        topic.stop()
    }
}
