// Mutex runtime. The opaque handle a seed mutex holds is a TermMutex. Reached only through the public mutex API.
//
// A waiter SUSPENDS, it never blocks a thread. The lock this replaced was a ReentrantLock held from `lock` to
// `unlock`: a coroutine holding it across a suspension parked every waiter's thread, and the unlock could run on
// another thread than the lock, which a ReentrantLock refuses with IllegalMonitorStateException
// (codegen-performance-0004). Here `held` and the queue of waiting continuations are guarded by the object's monitor,
// taken only inside a synchronous section and never across a suspension, and `unlock` hands the mutex straight to the
// next waiter in arrival order. Only the Kotlin standard library's `suspendCoroutine`: kotlinx.coroutines is not on
// every classpath this runs on. The queue is java.util.ArrayDeque, read with `pollFirst`: `removeFirst` names the JDK
// 21 List method on Android below API 35 (test/compile/kotlin-android.ts)
class TermMutex {
    private var held = false
    private val waiting = java.util.ArrayDeque<kotlin.coroutines.Continuation<Unit>>()

    suspend fun lock() {
        kotlin.coroutines.suspendCoroutine<Unit> { waiter ->
            val now = synchronized(this) {
                if (!held) {
                    held = true
                    true
                } else {
                    waiting.addLast(waiter)
                    false
                }
            }

            if (now) {
                waiter.resumeWith(Result.success(Unit))
            }
        }
    }

    fun unlock() {
        // the mutex stays held when there is a waiter: it passes to that one
        val next = synchronized(this) {
            val first = waiting.pollFirst()

            if (first == null) {
                held = false
            }

            first
        }

        next?.resumeWith(Result.success(Unit))
    }
}

object mutex {
    fun make(): TermMutex = TermMutex()
    suspend fun lock(handle: TermMutex) {
        handle.lock()
    }
    suspend fun unlock(handle: TermMutex) {
        handle.unlock()
    }
}
