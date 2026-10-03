// Channel runtime: an unbounded buffer and a queue of waiting receivers. `send` hands a value to the longest-waiting
// receiver, or buffers it; `receive` takes the oldest buffered value, or SUSPENDS until a send arrives. A message is any
// Term value, boxed as `Any`: the public `channel` form is what types it, by a cast on the way out. The opaque handle a
// seed channel holds is this TermChannel. Reached only through the public channel API.
//
// A receive used to `take()` from a LinkedBlockingQueue inside a suspend function, parking its thread for as long as
// the channel was empty (codegen-performance-0004). The monitor here is taken only inside synchronous sections, never
// across a suspension. Only the Kotlin standard library's `suspendCoroutine`. The queues are java.util.ArrayDeque,
// read with `pollFirst`: `removeFirst` names the JDK 21 List method on Android below API 35
class TermChannel {
    private val buffer = java.util.ArrayDeque<Any>()
    private val waiting = java.util.ArrayDeque<kotlin.coroutines.Continuation<Any>>()

    fun send(item: Any) {
        val receiver = synchronized(this) {
            val first = waiting.pollFirst()

            if (first == null) {
                buffer.addLast(item)
            }

            first
        }

        receiver?.resumeWith(Result.success(item))
    }

    suspend fun receive(): Any =
        kotlin.coroutines.suspendCoroutine { receiver ->
            val ready = synchronized(this) {
                val first = buffer.pollFirst()

                if (first == null) {
                    waiting.addLast(receiver)
                }

                first
            }

            if (ready != null) {
                receiver.resumeWith(Result.success(ready))
            }
        }
}

object channel {
    fun make(): TermChannel = TermChannel()

    suspend fun send(target: TermChannel, item: Any) {
        target.send(item)
    }

    suspend fun receive(source: TermChannel): Any = source.receive()

    suspend fun close(target: TermChannel) {}
}
