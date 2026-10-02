// TCP runtime over tokio::net. The opaque handle a seed connection / listener holds is an Arc-wrapped TcpStream /
// TcpListener (Arc so the handle is Clone, which every emitted struct derives; tokio's read / write / accept take
// &self, so a shared reference is enough). Async on every operation. Reached only through the public TCP API.
mod tcp {
    use std::sync::Arc;
    use tokio::net::{TcpListener, TcpStream};

    pub async fn connect(host: String, port: i64, _secure: bool) -> Arc<TcpStream> {
        let stream = TcpStream::connect(format!("{}:{}", host, port))
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
        let listener = TcpListener::bind(format!("{}:{}", host, port))
            .await
            .expect("tcp bind");
        Arc::new(listener)
    }

    pub async fn accept(listener: Arc<TcpListener>) -> Arc<TcpStream> {
        let (stream, _) = listener.accept().await.expect("tcp accept");
        Arc::new(stream)
    }

    pub async fn read(stream: Arc<TcpStream>) -> String {
        let mut buffer = vec![0u8; 65536];
        loop {
            if stream.readable().await.is_err() {
                return String::new();
            }
            match stream.try_read(&mut buffer) {
                Ok(0) => return String::new(),
                Ok(count) => {
                    return String::from_utf8_lossy(&buffer[..count]).to_string()
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    continue
                }
                Err(_) => return String::new(),
            }
        }
    }

    pub async fn write(stream: Arc<TcpStream>, data: String) -> i64 {
        loop {
            if stream.writable().await.is_err() {
                return 0;
            }
            match stream.try_write(data.as_bytes()) {
                Ok(count) => return count as i64,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    continue
                }
                Err(_) => return 0,
            }
        }
    }

    // tokio closes the socket when the last Arc to the stream drops; there is no explicit async close.
    pub async fn close(_stream: Arc<TcpStream>) {}

    pub async fn close_server(_listener: Arc<TcpListener>) {}
}
