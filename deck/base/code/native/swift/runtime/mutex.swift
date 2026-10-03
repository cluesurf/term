// Mutex runtime. The opaque handle a seed mutex holds is a SeedMutex. Reached only through the public mutex API.
//
// A waiter SUSPENDS, it never blocks a thread. The lock this replaced was an NSLock held from `lock` to `unlock`: a
// task holding it across an `await` left every waiter blocking a thread of Swift's cooperative pool, which has one per
// core, so enough waiters deadlocked the program; and the unlock could run on another thread than the lock, which
// NSLock does not allow (codegen-performance-0004). Here `held` and the queue of waiting continuations are guarded by
// a small lock taken only inside synchronous methods, never across a suspension, and `unlock` hands the mutex straight
// to the next waiter in arrival order.
import Foundation

final class SeedMutex: @unchecked Sendable {
    private let state = NSLock()
    private var held = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    // takes the mutex and resumes at once, or queues the waiter for the unlock that hands it over
    private func acquire(_ waiter: CheckedContinuation<Void, Never>) {
        state.lock()

        if !held {
            held = true
            state.unlock()
            waiter.resume()
        } else {
            waiting.append(waiter)
            state.unlock()
        }
    }

    func lock() async {
        await withCheckedContinuation { acquire($0) }
    }

    func unlock() {
        state.lock()

        if waiting.isEmpty {
            held = false
            state.unlock()
        } else {
            // the mutex stays held: it passes to the next waiter
            let next = waiting.removeFirst()
            state.unlock()
            next.resume()
        }
    }
}

enum mutex {
    static func make() -> SeedMutex { SeedMutex() }
    static func lock(_ handle: SeedMutex) async { await handle.lock() }
    static func unlock(_ handle: SeedMutex) async { handle.unlock() }
}
