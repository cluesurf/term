// The watchers' fan-out on Android and the desktop JVM (device-layer-0016), docked as `<global:native-watch>` by every
// host tree whose capability can be watched. Many handlers share one platform subscription per capability: the first
// watch starts it, the last drop stops it, and a watch made while it runs hears the last answer at once, so every handler
// is told the current value first. Everything here runs on the main thread, where every capability delivers.

object nativeWatch {
    private class Topic {
        val handlers = sortedMapOf<Int, (String) -> Unit>()
        var last: String? = null
        var stop: () -> Unit = {}
    }

    private val topics = mutableMapOf<String, Topic>()
    private var next = 0

    // `handler` added to the capability `name`, and the number that removes it. `start` begins the platform's
    // subscription with the function every answer goes through, and answers the function that ends it
    fun join(name: String, handler: (String) -> Unit, start: ((String) -> Unit) -> () -> Unit): Int {
        next += 1
        val id = next
        val topic = topics.getOrPut(name) { Topic() }
        topic.handlers[id] = handler

        if (topic.handlers.size > 1) {
            topic.last?.let(handler)
            return id
        }

        val stop = start { value ->
            topic.last = value
            // in the order they joined, and over a copy: a handler may drop itself, or another, as it is told
            for (key in topic.handlers.keys.toList()) {
                topic.handlers[key]?.invoke(value)
            }
        }

        // a handler told at once may have dropped itself before the subscription's end was known
        if (topics[name] === topic) topic.stop = stop else stop()
        return id
    }

    fun leave(name: String, id: Int) {
        val topic = topics[name] ?: return
        if (topic.handlers.remove(id) == null || topic.handlers.isNotEmpty()) return
        topics.remove(name)
        topic.stop()
    }
}
