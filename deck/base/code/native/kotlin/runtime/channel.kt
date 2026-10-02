// Channel runtime over java.util.concurrent.LinkedBlockingQueue. The opaque handle a seed channel holds is the queue. A
// message is any Term value, boxed as `Any`: the public `channel` form is what types it, by a cast on the way out. send
// puts (never blocks, unbounded); receive takes, blocking until a value is available. Reached only through the public
// channel API.
object channel {
    fun make(): java.util.concurrent.BlockingQueue<Any> =
        java.util.concurrent.LinkedBlockingQueue<Any>()

    suspend fun send(target: java.util.concurrent.BlockingQueue<Any>, item: Any) {
        target.put(item)
    }

    suspend fun receive(source: java.util.concurrent.BlockingQueue<Any>): Any =
        source.take()

    suspend fun close(target: java.util.concurrent.BlockingQueue<Any>) {}
}
