// Channel runtime: a thread-safe buffer with a counting semaphore. send appends and signals; receive waits on the
// semaphore then removes the head, so a value sent before receive is buffered and a receive before send blocks until a
// value arrives. A message is any Term value, boxed as `Any`: the public `channel` form is what types it, by a cast on
// the way out. The opaque handle a seed channel holds is this SeedChannel. Reached only through the public channel API.
import Foundation

final class SeedChannel {
    private var buffer: [Any] = []
    private let lock = NSLock()
    private let ready = DispatchSemaphore(value: 0)

    func send(_ item: Any) {
        lock.lock()
        buffer.append(item)
        lock.unlock()
        ready.signal()
    }

    func receive() -> Any {
        ready.wait()
        lock.lock()
        let value = buffer.removeFirst()
        lock.unlock()
        return value
    }
}

enum channel {
    static func make() -> SeedChannel { SeedChannel() }
    static func send(_ target: SeedChannel, _ item: Any) async { target.send(item) }
    static func receive(_ source: SeedChannel) async -> Any { source.receive() }
    static func close(_ target: SeedChannel) async {}
}
