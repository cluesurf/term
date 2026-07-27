// Mutex runtime over java.util.concurrent.locks.ReentrantLock. The opaque handle a seed mutex holds is the lock. Reached
// only through the public mutex API.
object mutex {
    fun make(): java.util.concurrent.locks.ReentrantLock =
        java.util.concurrent.locks.ReentrantLock()
    suspend fun lock(handle: java.util.concurrent.locks.ReentrantLock) {
        handle.lock()
    }
    suspend fun unlock(handle: java.util.concurrent.locks.ReentrantLock) {
        handle.unlock()
    }
}
