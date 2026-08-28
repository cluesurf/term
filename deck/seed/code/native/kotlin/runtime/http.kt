import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest

object http {
    // `header` is a map of name to value and may be empty. Written to match
    // the node runtime, and NOT exercised here: this repository builds and
    // tests the node target only.
    suspend fun request(method: String, url: String, body: String, header: Map<String, String>): HttpResponse {
        return try {
            val builder = HttpRequest.newBuilder().uri(URI.create(url))
            for ((name, value) in header) builder.header(name, value)
            if (method == "GET") builder.GET() else builder.method(method, HttpRequest.BodyPublishers.ofString(body))
            val resp = HttpClient.newHttpClient().send(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofString())
            HttpResponse(resp.statusCode().toLong(), resp.body())
        } catch (e: Exception) {
            HttpResponse(0L, "")
        }
    }
}
