// Atomic integer runtime: a lock-guarded cell (Swift's standard library has no portable atomic integer without the
// Atomics package, and a lock gives the same observable atomicity). The opaque handle a seed atomic holds is this
// SeedAtomic. Reached only through the public atomic API.
import Foundation

final class SeedAtomic {
    private var value: Int
    private let lock = NSLock()
    init(_ initial: Int) { value = initial }
    func load() -> Int { lock.lock(); defer { lock.unlock() }; return value }
    func store(_ newValue: Int) { lock.lock(); value = newValue; lock.unlock() }
    func increase(_ delta: Int) -> Int {
        lock.lock(); defer { lock.unlock() }; value += delta; return value
    }
}

enum atomic {
    static func make(_ initial: Int) -> SeedAtomic { SeedAtomic(initial) }
    static func load(_ cell: SeedAtomic) -> Int { cell.load() }
    static func store(_ cell: SeedAtomic, _ value: Int) { cell.store(value) }
    static func increase(_ cell: SeedAtomic, _ delta: Int) -> Int { cell.increase(delta) }
}
