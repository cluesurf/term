// The watchers' fan-out on Android and the desktop JVM (device-layer-0016), docked as `<global:native-watch>` by every
// host tree whose capability can be watched. Many handlers share one platform subscription per capability: the first
// watch starts it, the last drop stops it, and a watch made while it runs hears the last answer at once, so every handler
// is told the current value first.
//
// Safe from any thread: Android views resume a program's async code on the main thread, but Compose resumes it wherever
// the call it awaited finished, so a watch can come from either. The capabilities deliver on the main thread. A handler
// is called outside the lock, so it may watch or drop as it is told.

object nativeWatch {
    private class Topic {
        val handlers = sortedMapOf<Int, (String) -> Unit>()
        var last: String? = null
        var stop: () -> Unit = {}
    }

    private val lock = Any()
    private val topics = mutableMapOf<String, Topic>()
    private var next = 0

    // `handler` added to the capability `name`, and the number that removes it. `start` begins the platform's
    // subscription with the function every answer goes through, and answers the function that ends it
    fun join(name: String, handler: (String) -> Unit, start: ((String) -> Unit) -> () -> Unit): Int {
        val id: Int
        val topic: Topic
        val first: Boolean
        val last: String?
        synchronized(lock) {
            next += 1
            id = next
            topic = topics.getOrPut(name) { Topic() }
            topic.handlers[id] = handler
            first = topic.handlers.size == 1
            last = topic.last
        }

        if (!first) {
            last?.let(handler)
            return id
        }

        val stop = start { value ->
            // in the order they joined, each looked up as it is told: a handler may drop itself, or another
            val keys = synchronized(lock) {
                topic.last = value
                topic.handlers.keys.toList()
            }
            for (key in keys) {
                synchronized(lock) { topic.handlers[key] }?.invoke(value)
            }
        }

        // a handler told at once may have dropped itself before the subscription's end was known
        val kept = synchronized(lock) {
            if (topics[name] === topic) topic.stop = stop
            topics[name] === topic
        }
        if (!kept) stop()
        return id
    }

    fun leave(name: String, id: Int) {
        val ended = synchronized(lock) {
            val topic = topics[name] ?: return
            if (topic.handlers.remove(id) == null || topic.handlers.isNotEmpty()) return
            topics.remove(name)
            topic
        }
        ended.stop()
    }
}
