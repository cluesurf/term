import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest

object http {
    suspend fun request(method: String, url: String, body: String): HttpResponse {
        return try {
            val builder = HttpRequest.newBuilder().uri(URI.create(url))
            if (method == "GET") builder.GET() else builder.method(method, HttpRequest.BodyPublishers.ofString(body))
            val resp = HttpClient.newHttpClient().send(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofString())
            HttpResponse(resp.statusCode().toLong(), resp.body())
        } catch (e: Exception) {
            HttpResponse(0L, "")
        }
    }
}
