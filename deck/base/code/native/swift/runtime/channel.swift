// Text channel runtime: a thread-safe buffer with a counting semaphore. send appends and signals; receive waits on the
// semaphore then removes the head, so a value sent before receive is buffered and a receive before send blocks until a
// value arrives. The opaque handle a seed channel holds is this SeedChannel. Reached only through the public channel API.
import Foundation

final class SeedChannel {
    private var buffer: [String] = []
    private let lock = NSLock()
    private let ready = DispatchSemaphore(value: 0)

    func send(_ item: String) {
        lock.lock()
        buffer.append(item)
        lock.unlock()
        ready.signal()
    }

    func receive() -> String {
        ready.wait()
        lock.lock()
        let value = buffer.removeFirst()
        lock.unlock()
        return value
    }
}

enum channel {
    static func make() -> SeedChannel { SeedChannel() }
    static func send(_ target: SeedChannel, _ item: String) async { target.send(item) }
    static func receive(_ source: SeedChannel) async -> String { source.receive() }
    static func close(_ target: SeedChannel) async {}
}
