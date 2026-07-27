// UDP runtime over tokio::net::UdpSocket. The opaque handle a seed socket holds is an Arc-wrapped UdpSocket (Arc so the
// handle is Clone, which every emitted struct derives; send / recv take &self). `receive` returns the seed `datagram`
// form with the payload and sender address. Async on every operation. Reached only through the public UDP API.
mod udp {
    use super::Datagram;
    use std::sync::Arc;
    use tokio::net::UdpSocket;

    pub async fn open(port: i64, host: String) -> Arc<UdpSocket> {
        let socket = UdpSocket::bind(format!("{}:{}", host, port))
            .await
            .expect("udp bind");
        Arc::new(socket)
    }

    pub async fn send(
        socket: Arc<UdpSocket>,
        data: String,
        host: String,
        port: i64,
    ) -> i64 {
        socket
            .send_to(data.as_bytes(), format!("{}:{}", host, port))
            .await
            .map(|count| count as i64)
            .unwrap_or(0)
    }

    pub async fn receive(socket: Arc<UdpSocket>) -> Datagram {
        let mut buffer = vec![0u8; 65536];
        match socket.recv_from(&mut buffer).await {
            Ok((count, address)) => Datagram {
                data: String::from_utf8_lossy(&buffer[..count]).to_string(),
                host: address.ip().to_string(),
                port: address.port() as i64,
            },
            Err(_) => Datagram {
                data: String::new(),
                host: String::new(),
                port: 0,
            },
        }
    }

    pub async fn close(_socket: Arc<UdpSocket>) {}
}
