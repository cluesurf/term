// TCP runtime over java.net (plain) and javax.net.ssl (secure). The opaque handle a seed connection / listener holds
// is the raw java Socket / ServerSocket. Each call is a suspend function wrapping the blocking java call, matching the
// public async TCP API. Reached only through the public TCP API.
object tcp {
    suspend fun connect(host: String, port: Long, secure: Boolean): java.net.Socket =
        if (secure)
            javax.net.ssl.SSLSocketFactory.getDefault().createSocket(host, port.toInt())
        else
            java.net.Socket(host, port.toInt())

    suspend fun listen(
        port: Long,
        host: String,
        secure: Boolean,
        certificate: String,
        key: String,
    ): java.net.ServerSocket =
        java.net.ServerSocket(port.toInt(), 50, java.net.InetAddress.getByName(host))

    suspend fun accept(server: java.net.ServerSocket): java.net.Socket = server.accept()

    suspend fun read(socket: java.net.Socket): String {
        val buffer = ByteArray(65536)
        val count = socket.getInputStream().read(buffer)
        return if (count <= 0) "" else String(buffer, 0, count, Charsets.UTF_8)
    }

    suspend fun write(socket: java.net.Socket, data: String): Long {
        val bytes = data.toByteArray(Charsets.UTF_8)
        val stream = socket.getOutputStream()
        stream.write(bytes)
        stream.flush()
        return bytes.size.toLong()
    }

    suspend fun close(socket: java.net.Socket) { socket.close() }

    suspend fun closeServer(server: java.net.ServerSocket) { server.close() }
}
