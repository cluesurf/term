// TCP runtime over std::net. The opaque handle a seed connection / listener holds is an Arc-wrapped TcpStream /
// TcpListener (Arc so the handle is Clone, which every emitted struct derives; std's Read and Write are implemented
// for &TcpStream and accept takes &self, so a shared reference is enough). Reached only through the public TCP API.
//
// Every call that can wait (resolve, bind, connect, accept, read, write) is HANDED BACK
// (note/project/term/decision/001-native-work-hands-back-to-the-loop.md): `crate::__term_hand_back` runs the blocking
// std call on the runtime's pool and wakes the loop when it answers, as aio.rs does for a read. tokio::net sockets
// needed a tokio reactor, and a program built as `term make --build` builds one runs on Term's own loop,
// `__term_block_on`, which has none, so every built program that opened a socket panicked "there is no reactor
// running" (item 1151).
mod tcp {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
    use std::sync::Arc;

    // a listener as tokio::net::TcpListener::bind made it: SO_REUSEADDR on unix (node's listen sets it too), so a
    // server started again at once is not refused while the last one's closed connections wait out TIME_WAIT. std's
    // own bind does not set it. tokio's TcpSocket builds the socket and binds it with no reactor (only its `listen`
    // registers one), and the bound descriptor becomes a blocking std listener.
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
        // TcpSocket opens it non-blocking for its reactor, and accept here blocks a pool worker instead
        listener.set_nonblocking(false)?;
        Ok(listener)
    }

    #[cfg(not(unix))]
    fn bind_listener(address: SocketAddr) -> std::io::Result<TcpListener> {
        TcpListener::bind(address)
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
        let stream = crate::__term_hand_back(move || TcpStream::connect(at))
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
        let (stream, _) = crate::__term_hand_back(move || listener.accept())
            .await
            .expect("tcp accept");
        Arc::new(stream)
    }

    // what one read gives, up to 64 KiB, or the empty text at the end of the stream or on an error
    pub async fn read(stream: Arc<TcpStream>) -> String {
        crate::__term_hand_back(move || {
            let mut buffer = vec![0u8; 65536];
            loop {
                match (&*stream).read(&mut buffer) {
                    Ok(count) => {
                        return String::from_utf8_lossy(&buffer[..count]).to_string()
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                        continue
                    }
                    Err(_) => return String::new(),
                }
            }
        })
        .await
    }

    // how many bytes one write took, 0 on an error
    pub async fn write(stream: Arc<TcpStream>, data: String) -> i64 {
        crate::__term_hand_back(move || loop {
            match (&*stream).write(data.as_bytes()) {
                Ok(count) => return count as i64,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return 0,
            }
        })
        .await
    }

    // the socket closes when the last Arc to it drops; there is no explicit close.
    pub async fn close(_stream: Arc<TcpStream>) {}

    pub async fn close_server(_listener: Arc<TcpListener>) {}
}
