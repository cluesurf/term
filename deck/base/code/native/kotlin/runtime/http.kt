import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest

// The one HTTP primitive over java.net.http. Answers a flat list of text: `ok`, the status, the body, then each
// response header as a lower-case name and its value; or `timeout` / `outage` and the host's message. The public http
// module (base/code/network/http.tree) builds the response from it, so every backend answers alike.
object http {
    suspend fun request(method: String, url: String, body: String, header: Map<String, String>, timeout: Long): MutableList<String> {
        return try {
            val wait = java.time.Duration.ofMillis(maxOf(1L, timeout))
            val builder = HttpRequest.newBuilder().uri(URI.create(url)).timeout(wait)
            for ((name, value) in header) builder.header(name, value)
            val publisher = if (body.isEmpty()) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body)
            builder.method(method, publisher)
            val client = HttpClient.newBuilder().connectTimeout(wait).build()
            val response = client.send(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofString())
            val out = mutableListOf("ok", response.statusCode().toString(), response.body())
            for ((name, values) in response.headers().map()) {
                out.add(name.lowercase())
                out.add(values.joinToString(", "))
            }
            out
        } catch (error: java.net.http.HttpTimeoutException) {
            mutableListOf("timeout", error.toString())
        } catch (error: Throwable) {
            mutableListOf("outage", error.toString())
        }
    }
}
