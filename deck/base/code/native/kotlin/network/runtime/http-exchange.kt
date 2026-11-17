// HTTP over java.net.http: whole requests, and exchanges held by number. `request` sends a text body and answers `ok`,
// the status, the body as text, then each response header as a lower-case name and its value. `open` sends the
// request, its body as bytes (none when empty), redirects followed only under `follow` (`Redirect.ALWAYS`, as node's
// fetch follows any; else `NEVER`, which answers the redirect as it is), and answers `ok`, the exchange's number, the
// status, then each response header the same way. Either answers `timeout` / `outage` and the host's message instead.
// An exchange's body stays an unread input stream: `read` takes up to `room` bytes of it, `fault` says after each read
// whether it broke off (and lets go of an exchange whose body ended), `cancel` closes it unread.
//
// The timeout is one deadline over the whole answer, from the call to the body's last byte, as on node and rust
// (decision 179 rule 7, item term-self-host-001-1585). The client's own request timeout holds only until the headers,
// so the deadline is the answer future's `orTimeout` from the call, and each read of an exchange is given only what is
// left of it. A blocking read runs off the loop and is awaited through `termLoop.await` (decision 001). The public
// http module (base/code/network/http.tree) raises from these, so every backend answers alike.
class HttpExchangeHeld(var stream: java.io.InputStream?, val deadline: Long, val timeout: Long) {
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

    private fun late(timeout: Long): MutableList<String> =
        kotlin.collections.mutableListOf("timeout", "timed out after $timeout ms")

    // the request, its body as `publisher`, and the client, HTTP/1.1 on a plain http:// url as runtime/http.kt asks
    // (item term-self-host-001-1218)
    private fun made(method: String, url: String, publisher: java.net.http.HttpRequest.BodyPublisher, header: Map<String, String>, wait: java.time.Duration): java.net.http.HttpRequest {
        val builder = java.net.http.HttpRequest.newBuilder().uri(java.net.URI.create(url)).timeout(wait)
        for ((name, value) in header) builder.header(name, value)
        builder.method(method, publisher)
        return builder.build()
    }

    private fun client(url: String, wait: java.time.Duration, follow: Boolean): java.net.http.HttpClient {
        val plain = url.startsWith("http://", ignoreCase = true)
        return java.net.http.HttpClient.newBuilder().connectTimeout(wait)
            .followRedirects(if (follow) java.net.http.HttpClient.Redirect.ALWAYS else java.net.http.HttpClient.Redirect.NEVER)
            .apply { if (plain) version(java.net.http.HttpClient.Version.HTTP_1_1) }
            .build()
    }

    // the answer future awaited within `limit` milliseconds, cancelled when it is not done by then
    private suspend fun <T> within(future: java.util.concurrent.CompletableFuture<T>, limit: Long): T {
        return try {
            termLoop.await(future.orTimeout(limit, java.util.concurrent.TimeUnit.MILLISECONDS))
        } catch (error: Throwable) {
            future.cancel(true)
            throw error
        }
    }

    suspend fun request(method: String, url: String, body: String, header: Map<String, String>, timeout: Long): MutableList<String> {
        return try {
            val limit = kotlin.comparisons.maxOf(1L, timeout)
            val wait = java.time.Duration.ofMillis(limit)
            val publisher =
                if (body.isEmpty()) java.net.http.HttpRequest.BodyPublishers.noBody()
                else java.net.http.HttpRequest.BodyPublishers.ofString(body)
            // a redirect answered as runtime/http.kt's client answered it, by the JDK's default (NEVER)
            val asked = client(url, wait, false).sendAsync(made(method, url, publisher, header, wait), java.net.http.HttpResponse.BodyHandlers.ofString())
            val response = within(asked, limit)
            val out = kotlin.collections.mutableListOf("ok", response.statusCode().toString(), response.body())
            for ((name, values) in response.headers().map()) {
                out.add(name.lowercase())
                out.add(values.joinToString(", "))
            }
            out
        } catch (error: Throwable) {
            failed(error)
        }
    }

    suspend fun open(method: String, url: String, body: ByteArray, header: Map<String, String>, timeout: Long, follow: Boolean): MutableList<String> {
        return try {
            send(method, url, body, header, timeout, follow)
        } catch (error: Throwable) {
            failed(error)
        }
    }

    private suspend fun send(method: String, url: String, body: ByteArray, header: Map<String, String>, timeout: Long, follow: Boolean): MutableList<String> {
        val limit = kotlin.comparisons.maxOf(1L, timeout)
        val deadline = System.nanoTime() + limit * 1_000_000L
        val wait = java.time.Duration.ofMillis(limit)
        val publisher =
            if (body.isEmpty()) java.net.http.HttpRequest.BodyPublishers.noBody()
            else java.net.http.HttpRequest.BodyPublishers.ofByteArray(body)
        val asked = client(url, wait, follow).sendAsync(made(method, url, publisher, header, wait), java.net.http.HttpResponse.BodyHandlers.ofInputStream())
        val response = within(asked, limit)
        val ticket = next.incrementAndGet()
        held[ticket] = HttpExchangeHeld(response.body(), deadline, limit)
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
        // what is left of the deadline set at open; none left is a timeout before a byte is read
        val left = (one.deadline - System.nanoTime()) / 1_000_000L
        if (left <= 0L) {
            one.fault = late(one.timeout)
            one.done = true
            one.stream = null
            try { stream.close() } catch (ignored: Throwable) {}
            return ByteArray(0)
        }
        return try {
            val reading = java.util.concurrent.CompletableFuture.supplyAsync { stream.readNBytes(want) }
                .orTimeout(left, java.util.concurrent.TimeUnit.MILLISECONDS)
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
