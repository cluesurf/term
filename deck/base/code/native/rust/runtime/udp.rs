// UDP runtime over std::net::UdpSocket. The opaque handle a seed socket holds is an Arc-wrapped UdpSocket (Arc so the
// handle is Clone, which every emitted struct derives; send_to / recv_from take &self). `receive` returns the seed
// `datagram` form with the payload and sender address. Reached only through the public UDP API.
//
// Every call that can wait (bind, send, receive) is HANDED BACK
// (note/project/term/decision/001-native-work-hands-back-to-the-loop.md): `crate::__term_hand_back` runs the blocking
// std call on the runtime's pool and wakes the loop when it answers, as aio.rs does for a read. tokio::net::UdpSocket
// needed a tokio reactor, and a program built as `term make --build` builds one runs on Term's own loop,
// `__term_block_on`, which has none, so every built program that opened a socket panicked "there is no reactor
// running" (item 1152).
mod udp {
    use super::Datagram;
    use std::net::UdpSocket;
    use std::sync::Arc;

    pub async fn open(port: i64, host: String) -> Arc<UdpSocket> {
        let at = format!("{}:{}", host, port);
        let socket = crate::__term_hand_back(move || UdpSocket::bind(at))
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
        let at = format!("{}:{}", host, port);
        crate::__term_hand_back(move || {
            socket
                .send_to(data.as_bytes(), at)
                .map(|count| count as i64)
                .unwrap_or(0)
        })
        .await
    }

    pub async fn receive(socket: Arc<UdpSocket>) -> Datagram {
        crate::__term_hand_back(move || {
            let mut buffer = vec![0u8; 65536];
            match socket.recv_from(&mut buffer) {
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
        })
        .await
    }

    pub async fn close(_socket: Arc<UdpSocket>) {}
}
