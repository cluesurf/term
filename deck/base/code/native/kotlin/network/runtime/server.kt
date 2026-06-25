// kotlin HTTP server runtime over the JDK's built-in com.sun.net.httpserver (no external dependency). It reads each
// request, hands a normalized Request to the seed handler, and writes the response. `serve` starts the server (which runs
// on its own threads) and blocks the calling thread so the process stays alive -- the entry point of a server binary.
// Reached only through the public network/server API.
object runtime {
  fun serve(port: Long, host: String, handler: (Request) -> Response) {
    val server = com.sun.net.httpserver.HttpServer.create(
      java.net.InetSocketAddress(host, port.toInt()),
      0,
    )

    server.createContext("/") { exchange ->
      val body = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
      val uri = exchange.requestURI
      val request = Request(
        exchange.requestMethod,
        uri.toString(),
        uri.path ?: "/",
        uri.rawQuery ?: "",
        mutableMapOf(),
        body,
        0L,
      )
      val response = handler(request)
      val bytes = response.body.toByteArray(Charsets.UTF_8)
      exchange.sendResponseHeaders(response.status.toInt(), bytes.size.toLong())
      exchange.responseBody.use { it.write(bytes) }
    }

    server.start()
    Thread.currentThread().join()
  }
}
