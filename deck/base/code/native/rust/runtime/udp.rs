// UDP runtime over std::net::UdpSocket. The opaque handle a seed socket holds is an Arc-wrapped UdpSocket (Arc so the
// handle is Clone, which every emitted struct derives; send_to / recv_from take &self). `receive` returns the seed
// `datagram` form with the payload and sender address. Reached only through the public UDP API.
//
// A socket wait holds no pool worker (item 1156, ruled 2026-11-10: Term is identical on every backend). Every socket is
// non-blocking, and each send and receive is a future the program's loop re-polls: an attempt that would block answers
// pending, so any number of sockets wait at once, as on node. While it waits it notes a wake time in the loop's
// `__TERM_WAKE`, as a timer does, so `__term_block_on` sleeps until then and polls again rather than stopping with the
// defect or spinning: soon at first, backing off to 8 ms while the socket stays quiet. Binding and resolving a host
// name, which end on their own, are HANDED BACK (note/project/term/decision/001-native-work-hands-back-to-the-loop.md)
// through `crate::__term_hand_back`. tokio::net::UdpSocket needed a tokio reactor, which Term's own loop does not have
// (item 1152).
mod udp {
    use super::Datagram;
    use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
    use std::sync::Arc;

    // the longest a quiet socket waits between two attempts, in microseconds
    const QUIET_MOST: u64 = 8000;

    // one socket call retried each time the loop polls it, until it no longer would block
    struct Attempt<T, F: FnMut() -> std::io::Result<T> + Unpin> {
        call: F,
        tries: u32,
    }

    impl<T, F: FnMut() -> std::io::Result<T> + Unpin> std::future::Future for Attempt<T, F> {
        type Output = std::io::Result<T>;
        fn poll(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<T>> {
            let this = self.get_mut();
            loop {
                match (this.call)() {
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        // the first retry on the next round, then 50 us doubling up to QUIET_MOST
                        let quiet = if this.tries == 0 {
                            0
                        } else {
                            (50u64 << (this.tries - 1).min(16)).min(QUIET_MOST)
                        };
                        this.tries = this.tries.saturating_add(1);
                        let at = std::time::Instant::now() + std::time::Duration::from_micros(quiet);
                        crate::__TERM_WAKE.with(|wake| {
                            wake.set(Some(wake.get().map_or(at, |soonest| soonest.min(at))))
                        });
                        cx.waker().wake_by_ref();
                        return std::task::Poll::Pending;
                    }
                    answer => {
                        crate::__term_progressed();
                        return std::task::Poll::Ready(answer);
                    }
                }
            }
        }
    }

    fn attempt<T, F: FnMut() -> std::io::Result<T> + Unpin>(call: F) -> Attempt<T, F> {
        Attempt { call, tries: 0 }
    }

    pub async fn open(port: i64, host: String) -> Arc<UdpSocket> {
        let at = format!("{}:{}", host, port);
        let socket = crate::__term_hand_back(move || {
            let socket = UdpSocket::bind(at)?;
            socket.set_nonblocking(true)?;
            Ok::<UdpSocket, std::io::Error>(socket)
        })
        .await
        .expect("udp bind");
        Arc::new(socket)
    }

    // the address a send goes to: an address as written at once, a host name resolved by a hand-back. Only the first
    // address a name resolves to is used, as std's send_to does
    async fn address_of(host: String, port: i64) -> Option<SocketAddr> {
        let at = format!("{}:{}", host, port);
        if let Ok(address) = at.parse::<SocketAddr>() {
            return Some(address);
        }
        crate::__term_hand_back(move || at.to_socket_addrs().ok().and_then(|mut all| all.next())).await
    }

    pub async fn send(
        socket: Arc<UdpSocket>,
        data: String,
        host: String,
        port: i64,
    ) -> i64 {
        let address = match address_of(host, port).await {
            Some(address) => address,
            None => return 0,
        };
        attempt(|| socket.send_to(data.as_bytes(), address))
            .await
            .map(|count| count as i64)
            .unwrap_or(0)
    }

    pub async fn receive(socket: Arc<UdpSocket>) -> Datagram {
        let mut buffer = vec![0u8; 65536];
        let answer = attempt(|| socket.recv_from(&mut buffer)).await;
        match answer {
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
