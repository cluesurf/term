// WebSocket client runtime over java.net.http.WebSocket. The opaque handle a seed socket holds is a holder pairing the
// platform WebSocket with a blocking queue: the listener pushes every frame (and the close) onto the queue, and receive
// takes the next one, so a frame arriving before receive is called is buffered, not dropped. receive returns the seed
// `message` form. Reached only through the public WebSocket API.
class SeedWebSocketHolder(
    val socket: java.net.http.WebSocket,
    val queue: java.util.concurrent.BlockingQueue<Message>,
)

object websocket {
    suspend fun connect(url: String): SeedWebSocketHolder {
        val queue = java.util.concurrent.LinkedBlockingQueue<Message>()
        val listener = object : java.net.http.WebSocket.Listener {
            val buffer = StringBuilder()
            override fun onText(
                webSocket: java.net.http.WebSocket,
                data: CharSequence,
                last: Boolean,
            ): java.util.concurrent.CompletionStage<*>? {
                buffer.append(data)
                if (last) {
                    queue.put(Message("text", buffer.toString()))
                    buffer.setLength(0)
                }
                webSocket.request(1)
                return null
            }

            override fun onClose(
                webSocket: java.net.http.WebSocket,
                statusCode: Int,
                reason: String,
            ): java.util.concurrent.CompletionStage<*>? {
                queue.put(Message("close", ""))
                return null
            }
        }
        val socket = java.net.http.HttpClient.newHttpClient()
            .newWebSocketBuilder()
            .buildAsync(java.net.URI.create(url), listener)
            .get()
        return SeedWebSocketHolder(socket, queue)
    }

    suspend fun send(holder: SeedWebSocketHolder, data: String) {
        holder.socket.sendText(data, true).get()
    }

    suspend fun receive(holder: SeedWebSocketHolder): Message = holder.queue.take()

    suspend fun close(holder: SeedWebSocketHolder) {
        holder.socket.sendClose(java.net.http.WebSocket.NORMAL_CLOSURE, "").get()
    }
}
