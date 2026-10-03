// Channel runtime: an unbounded buffer and a queue of waiting receivers. `send` hands a value to the longest-waiting
// receiver, or buffers it; `receive` takes the oldest buffered value, or SUSPENDS until a send arrives. A message is any
// Term value, boxed as `Any`: the public `channel` form is what types it, by a cast on the way out. The opaque handle a
// seed channel holds is this SeedChannel. Reached only through the public channel API.
//
// A receive used to block on a DispatchSemaphore, which parks a thread of Swift's cooperative pool for as long as the
// channel is empty: one receiver per core and nothing else could run, the sender included (codegen-performance-0004).
// The small lock here is taken only inside synchronous methods, never across a suspension.
import Foundation

final class SeedChannel: @unchecked Sendable {
    private let state = NSLock()
    private var buffer: [Any] = []
    // the next unread buffered value: removing from the front of an array is O(n)
    private var head = 0
    private var waiting: [CheckedContinuation<Any, Never>] = []

    func send(_ item: Any) {
        state.lock()

        if waiting.isEmpty {
            buffer.append(item)
            state.unlock()
        } else {
            let receiver = waiting.removeFirst()
            state.unlock()
            receiver.resume(returning: item)
        }
    }

    // resumes the receiver with the oldest buffered value, or queues it for the next send
    private func take(_ receiver: CheckedContinuation<Any, Never>) {
        state.lock()

        if head < buffer.count {
            let value = buffer[head]
            head += 1

            // reclaim the read prefix once it is half the storage
            if head > 32 && head * 2 > buffer.count {
                buffer.removeFirst(head)
                head = 0
            }

            state.unlock()
            receiver.resume(returning: value)
        } else {
            waiting.append(receiver)
            state.unlock()
        }
    }

    func receive() async -> Any {
        await withCheckedContinuation { take($0) }
    }
}

enum channel {
    static func make() -> SeedChannel { SeedChannel() }
    static func send(_ target: SeedChannel, _ item: Any) async { target.send(item) }
    static func receive(_ source: SeedChannel) async -> Any { await source.receive() }
    static func close(_ target: SeedChannel) async {}
}
