// Text channel runtime over java.util.concurrent.LinkedBlockingQueue. The opaque handle a seed channel holds is the
// queue. send puts (never blocks, unbounded); receive takes, blocking until a value is available. Reached only through
// the public channel API.
object channel {
    fun make(): java.util.concurrent.BlockingQueue<String> =
        java.util.concurrent.LinkedBlockingQueue<String>()

    suspend fun send(target: java.util.concurrent.BlockingQueue<String>, item: String) {
        target.put(item)
    }

    suspend fun receive(source: java.util.concurrent.BlockingQueue<String>): String =
        source.take()

    suspend fun close(target: java.util.concurrent.BlockingQueue<String>) {}
}
