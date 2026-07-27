// Mutex runtime over NSLock. The opaque handle a seed mutex holds is the lock. Reached only through the public mutex API.
import Foundation

enum mutex {
    static func make() -> NSLock { NSLock() }
    static func lock(_ handle: NSLock) async { handle.lock() }
    static func unlock(_ handle: NSLock) async { handle.unlock() }
}
