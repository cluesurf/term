// TCP runtime over std::net. The opaque handle a seed connection / listener holds is an Arc-wrapped TcpStream /
// TcpListener (Arc so the handle is Clone, which every emitted struct derives; std's Read and Write are implemented
// for &TcpStream and accept takes &self, so a shared reference is enough). Reached only through the public TCP API.
//
// A socket wait holds no pool worker (item 1156, ruled 2026-11-10: Term is identical on every backend). Every socket is
// non-blocking, and each accept, read and write is a future the program's loop re-polls: an attempt that would block
// answers pending, so any number of sockets wait at once, as on node, whose sockets are not on libuv's pool either.
// While it waits it notes a wake time in the loop's `__TERM_WAKE`, as a timer does, so `__term_block_on` sleeps until
// then and polls again rather than stopping with the defect or spinning: soon at first, backing off to 8 ms while the
// socket stays quiet. Resolving and binding a listener and connecting, which end on their own, are HANDED BACK
// (note/project/term/decision/001-native-work-hands-back-to-the-loop.md) through `crate::__term_hand_back`, as aio.rs
// does for a read. tokio::net sockets needed a tokio reactor, which Term's own loop does not have (item 1151).
mod tcp {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
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

    // a listener as tokio::net::TcpListener::bind made it: SO_REUSEADDR on unix (node's listen sets it too), so a
    // server started again at once is not refused while the last one's closed connections wait out TIME_WAIT. std's
    // own bind does not set it. tokio's TcpSocket builds the socket and binds it with no reactor (only its `listen`
    // registers one), and the bound descriptor becomes a std listener.
    #[cfg(unix)]
    fn bind_listener(address: SocketAddr) -> std::io::Result<TcpListener> {
        use std::os::unix::io::{FromRawFd, IntoRawFd};

        let socket = if address.is_ipv4() {
            tokio::net::TcpSocket::new_v4()?
        } else {
            tokio::net::TcpSocket::new_v6()?
        };
        socket.set_reuseaddr(true)?;
        socket.bind(address)?;
        let descriptor = socket.into_raw_fd();
        // owned from here, so an early return below closes it
        let listener = unsafe { TcpListener::from_raw_fd(descriptor) };
        // tokio's own backlog
        if unsafe { libc::listen(descriptor, 1024) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        listener.set_nonblocking(true)?;
        Ok(listener)
    }

    #[cfg(not(unix))]
    fn bind_listener(address: SocketAddr) -> std::io::Result<TcpListener> {
        let listener = TcpListener::bind(address)?;
        listener.set_nonblocking(true)?;
        Ok(listener)
    }

    // each address the host resolves to, tried in order, as tokio's bind does
    fn listen_at(at: String) -> std::io::Result<TcpListener> {
        let mut last = None;
        for address in at.to_socket_addrs()? {
            match bind_listener(address) {
                Ok(listener) => return Ok(listener),
                Err(error) => last = Some(error),
            }
        }
        Err(last.unwrap_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "could not resolve to any address",
            )
        }))
    }

    pub async fn connect(host: String, port: i64, _secure: bool) -> Arc<TcpStream> {
        let at = format!("{}:{}", host, port);
        let stream = crate::__term_hand_back(move || {
            let stream = TcpStream::connect(at)?;
            stream.set_nonblocking(true)?;
            Ok::<TcpStream, std::io::Error>(stream)
        })
        .await
        .expect("tcp connect");
        Arc::new(stream)
    }

    pub async fn listen(
        port: i64,
        host: String,
        _secure: bool,
        _certificate: String,
        _key: String,
    ) -> Arc<TcpListener> {
        let at = format!("{}:{}", host, port);
        let listener = crate::__term_hand_back(move || listen_at(at))
            .await
            .expect("tcp bind");
        Arc::new(listener)
    }

    pub async fn accept(listener: Arc<TcpListener>) -> Arc<TcpStream> {
        let (stream, _) = attempt(move || listener.accept()).await.expect("tcp accept");
        // linux gives an accepted socket blocking mode whatever its listener's, and the BSDs pass the listener's on
        stream.set_nonblocking(true).expect("tcp accept");
        Arc::new(stream)
    }

    // what one read gives, up to 64 KiB, or the empty text at the end of the stream or on an error
    pub async fn read(stream: Arc<TcpStream>) -> String {
        let mut buffer = vec![0u8; 65536];
        let count = attempt(|| (&*stream).read(&mut buffer)).await;
        match count {
            Ok(count) => String::from_utf8_lossy(&buffer[..count]).to_string(),
            Err(_) => String::new(),
        }
    }

    // how many bytes one write took, 0 on an error
    pub async fn write(stream: Arc<TcpStream>, data: String) -> i64 {
        attempt(|| (&*stream).write(data.as_bytes()))
            .await
            .map(|count| count as i64)
            .unwrap_or(0)
    }

    // the socket closes when the last Arc to it drops; there is no explicit close.
    pub async fn close(_stream: Arc<TcpStream>) {}

    pub async fn close_server(_listener: Arc<TcpListener>) {}
}
