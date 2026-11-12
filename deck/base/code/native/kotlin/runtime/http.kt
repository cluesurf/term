import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest

// The one HTTP primitive over java.net.http. Answers a flat list of text: `ok`, the status, the body, then each
// response header as a lower-case name and its value; or `timeout` / `outage` and the host's message. The public http
// module (base/code/network/http.tree) builds the response from it, so every backend answers alike.
//
// The request is `sendAsync`, its future awaited through `termLoop.await` (decision 001): the coroutine resumes on the
// loop thread when the response arrives, and the other jobs run meanwhile. A failure arrives wrapped in a
// CompletionException, unwrapped here so a timeout still reads as `timeout`.
object http {
    suspend fun request(method: String, url: String, body: String, header: Map<String, String>, timeout: Long): MutableList<String> {
        return try {
            try {
                send(method, url, body, header, timeout)
            } catch (error: java.util.concurrent.CompletionException) {
                throw error.cause ?: error
            }
        } catch (error: java.net.http.HttpTimeoutException) {
            kotlin.collections.mutableListOf("timeout", error.toString())
        } catch (error: Throwable) {
            kotlin.collections.mutableListOf("outage", error.toString())
        }
    }

    private suspend fun send(method: String, url: String, body: String, header: Map<String, String>, timeout: Long): MutableList<String> {
        return kotlin.run {
            val wait = java.time.Duration.ofMillis(kotlin.comparisons.maxOf(1L, timeout))
            val builder = HttpRequest.newBuilder().uri(URI.create(url)).timeout(wait)
            for ((name, value) in header) builder.header(name, value)
            val publisher = if (body.isEmpty()) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body)
            builder.method(method, publisher)
            // HTTP/1.1 on a plain http:// url, as node's fetch, reqwest and URLSession ask (item term-self-host-001-1218).
            // The JDK client's default is HTTP/2, which on plain http sends an h2c upgrade request, and Ktor's CIO
            // server (the kotlin network/server) never answered one: every fetch of a Term server timed out. Over
            // https HTTP/2 is still offered, by ALPN
            val plain = url.startsWith("http://", ignoreCase = true)
            val client = HttpClient.newBuilder().connectTimeout(wait)
                .apply { if (plain) version(HttpClient.Version.HTTP_1_1) }
                .build()
            val response = termLoop.await(client.sendAsync(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofString()))
            val out = kotlin.collections.mutableListOf("ok", response.statusCode().toString(), response.body())
            for ((name, values) in response.headers().map()) {
                out.add(name.lowercase())
                out.add(values.joinToString(", "))
            }
            out
        }
    }
}
