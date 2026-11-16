// HTTP exchanges over java.net.http, held by number. `open` sends the request, its body as bytes (none when empty),
// redirects followed only under `follow` (`Redirect.ALWAYS`, as node's fetch follows any; else `NEVER`, which answers
// the redirect as it is), and answers `ok`, the exchange's number, the status, then each response header as a
// lower-case name and its value; or `timeout` / `outage` and the host's message. The body stays an unread input
// stream: `read` takes up to `room` bytes of it, `fault` says after each read whether it broke off (and lets go of an
// exchange whose body ended), `cancel` closes it unread. The client's timeout holds until the headers; each read has
// the same time again, its blocking read run off the loop and awaited through `termLoop.await` (decision 001). The
// public http module (base/code/network/http.tree) raises from these, so every backend answers alike.
class HttpExchangeHeld(var stream: java.io.InputStream?, val timeout: Long) {
    var done = false
    var fault: MutableList<String> = kotlin.collections.mutableListOf("", "")
}

object httpExchange {
    private val held = java.util.concurrent.ConcurrentHashMap<Long, HttpExchangeHeld>()
    private val next = java.util.concurrent.atomic.AtomicLong(0)

    private fun failed(error: Throwable): MutableList<String> {
        val cause = if (error is java.util.concurrent.CompletionException) error.cause ?: error else error
        val timed = cause is java.net.http.HttpTimeoutException || cause is java.util.concurrent.TimeoutException
        return kotlin.collections.mutableListOf(if (timed) "timeout" else "outage", cause.toString())
    }

    suspend fun open(method: String, url: String, body: ByteArray, header: Map<String, String>, timeout: Long, follow: Boolean): MutableList<String> {
        return try {
            send(method, url, body, header, timeout, follow)
        } catch (error: Throwable) {
            failed(error)
        }
    }

    private suspend fun send(method: String, url: String, body: ByteArray, header: Map<String, String>, timeout: Long, follow: Boolean): MutableList<String> {
        val wait = java.time.Duration.ofMillis(kotlin.comparisons.maxOf(1L, timeout))
        val builder = java.net.http.HttpRequest.newBuilder().uri(java.net.URI.create(url)).timeout(wait)
        for ((name, value) in header) builder.header(name, value)
        val publisher =
            if (body.isEmpty()) java.net.http.HttpRequest.BodyPublishers.noBody()
            else java.net.http.HttpRequest.BodyPublishers.ofByteArray(body)
        builder.method(method, publisher)
        // HTTP/1.1 on a plain http:// url, as runtime/http.kt asks (item term-self-host-001-1218)
        val plain = url.startsWith("http://", ignoreCase = true)
        val client = java.net.http.HttpClient.newBuilder().connectTimeout(wait)
            .followRedirects(if (follow) java.net.http.HttpClient.Redirect.ALWAYS else java.net.http.HttpClient.Redirect.NEVER)
            .apply { if (plain) version(java.net.http.HttpClient.Version.HTTP_1_1) }
            .build()
        val response = termLoop.await(client.sendAsync(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofInputStream()))
        val ticket = next.incrementAndGet()
        held[ticket] = HttpExchangeHeld(response.body(), kotlin.comparisons.maxOf(1L, timeout))
        val out = kotlin.collections.mutableListOf("ok", ticket.toString(), response.statusCode().toString())
        for ((name, values) in response.headers().map()) {
            out.add(name.lowercase())
            out.add(values.joinToString(", "))
        }
        return out
    }

    suspend fun read(ticket: Long, room: Long): ByteArray {
        val one = held[ticket] ?: return ByteArray(0)
        // a body already read to its end, asked again: gone, as `fault` then says
        if (one.done) {
            held.remove(ticket)
            return ByteArray(0)
        }
        val stream = one.stream
        if (stream == null) {
            one.done = true
            return ByteArray(0)
        }
        val want = room.coerceIn(0L, (Int.MAX_VALUE - 8).toLong()).toInt()
        return try {
            val reading = java.util.concurrent.CompletableFuture.supplyAsync { stream.readNBytes(want) }
                .orTimeout(one.timeout, java.util.concurrent.TimeUnit.MILLISECONDS)
            val got = termLoop.await(reading)
            if (got.size < want) {
                one.done = true
                one.stream = null
                stream.close()
            }
            got
        } catch (error: Throwable) {
            one.fault = failed(error)
            one.done = true
            one.stream = null
            try { stream.close() } catch (ignored: Throwable) {}
            ByteArray(0)
        }
    }

    fun fault(ticket: Long): MutableList<String> {
        val one = held[ticket] ?: return kotlin.collections.mutableListOf("gone", "no exchange $ticket is held")
        if (one.done) held.remove(ticket)
        return one.fault
    }

    fun cancel(ticket: Long) {
        val one = held.remove(ticket) ?: return
        try { one.stream?.close() } catch (ignored: Throwable) {}
    }
}
