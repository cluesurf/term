// UDP runtime over java.net.DatagramSocket. The opaque handle a seed socket holds is the raw DatagramSocket. Each call
// is a suspend function wrapping the blocking java call. `receive` returns the seed `datagram` form with the payload and
// sender address. Reached only through the public UDP API.
object udp {
    suspend fun open(port: Long, host: String): java.net.DatagramSocket =
        java.net.DatagramSocket(port.toInt(), java.net.InetAddress.getByName(host))

    suspend fun send(
        socket: java.net.DatagramSocket,
        data: String,
        host: String,
        port: Long,
    ): Long {
        val bytes = data.toByteArray(Charsets.UTF_8)
        val packet = java.net.DatagramPacket(
            bytes,
            bytes.size,
            java.net.InetAddress.getByName(host),
            port.toInt(),
        )
        socket.send(packet)
        return bytes.size.toLong()
    }

    suspend fun receive(socket: java.net.DatagramSocket): Datagram {
        val buffer = ByteArray(65536)
        val packet = java.net.DatagramPacket(buffer, buffer.size)
        socket.receive(packet)
        return Datagram(
            String(packet.data, 0, packet.length, Charsets.UTF_8),
            packet.address.hostAddress,
            packet.port.toLong(),
        )
    }

    suspend fun close(socket: java.net.DatagramSocket) { socket.close() }
}
