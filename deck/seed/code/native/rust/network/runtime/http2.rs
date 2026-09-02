// HTTP/2 server runtime for the rust target, over hyper's http2 builder on tokio.
//
// TWO WAYS IN, and they are genuinely different connections rather than a flag:
//
//   secure   TLS with ALPN advertising `h2`, which is the only way a browser speaks HTTP/2. rustls does the
//            negotiation; if the client cannot do h2 the handshake still completes and hyper's http2 builder
//            then fails that connection, which is correct: this module is HTTP/2, not a fallback.
//   clear    h2c with prior knowledge. No ALPN, no upgrade dance -- the client opens the connection and starts
//            speaking h2 immediately. This is what a proxy or a service mesh does when it already knows.
//
// ONE THREAD, for the same reason network/runtime/server.rs is: the handler a Term program hands in is an
// `Rc<dyn Fn(Request) -> Response>` and an Rc cannot cross a thread. hyper's http2 builder wants an executor to
// spawn per-stream tasks on, so this supplies one that spawns LOCALLY.
//
// Reached only through the public network/http2 API. See note/term/stdlib/native-async-file-and-server.md.
mod http2 {
    use super::{Header, Request, Response};
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::server::conn::http2;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;
    use tokio::net::TcpListener;

    pub type Handler = Rc<dyn Fn(Request) -> Response>;

    pub struct Running {
        pub stop: Option<tokio::sync::oneshot::Sender<()>>,
        pub port: i64,
    }

    pub type Server = Rc<RefCell<Running>>;

    // hyper's http2 builder spawns a task per stream and asks the caller for the executor. The Term handler is
    // !Send, so every one of those tasks has to stay on this thread: `spawn_local`, not `tokio::spawn`.
    #[derive(Clone)]
    struct LocalExec;

    impl<F> hyper::rt::Executor<F> for LocalExec
    where
        F: std::future::Future + 'static,
    {
        fn execute(&self, task: F) {
            tokio::task::spawn_local(async move {
                let _ = task.await;
            });
        }
    }

    // Run an HTTP/2 server and block for the life of the process: the entry point of a server binary. This is
    // the one that builds the runtime, so a Term program needs no `#[tokio::main]`.
    pub fn serve(
        port: i64,
        host: String,
        handler: Handler,
        secure: bool,
        certificate: String,
        key: String,
    ) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("http2 runtime");
        let local = tokio::task::LocalSet::new();

        local.block_on(&runtime, async move {
            // the sender is HELD: bound to `_` it drops here, the receiver resolves, and the accept loop shuts
            // down on its first poll having served nothing
            let (keep, forever) = tokio::sync::oneshot::channel::<()>();
            accept(port, host, handler, secure, certificate, key, forever).await;
            drop(keep);
        });
    }

    // Bind and answer without blocking. Must be called from inside a LocalSet, for the reason in the header.
    pub async fn start(
        port: i64,
        host: String,
        handler: Handler,
        secure: bool,
        certificate: String,
        key: String,
    ) -> Server {
        let (stop, halt) = tokio::sync::oneshot::channel::<()>();

        tokio::task::spawn_local(async move {
            accept(port, host, handler, secure, certificate, key, halt).await;
        });

        Rc::new(RefCell::new(Running {
            stop: Some(stop),
            port,
        }))
    }

    pub async fn stop(server: Server) {
        if let Some(stop) = server.borrow_mut().stop.take() {
            let _ = stop.send(());
        }
    }

    async fn accept(
        port: i64,
        host: String,
        handler: Handler,
        secure: bool,
        certificate: String,
        key: String,
        halt: tokio::sync::oneshot::Receiver<()>,
    ) {
        let listener = match TcpListener::bind(format!("{}:{}", host, port)).await {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("http2 bind {}:{}: {}", host, port, error);

                return;
            }
        };

        let tls = if secure {
            match acceptor(&certificate, &key) {
                Some(acceptor) => Some(acceptor),
                None => {
                    eprintln!("http2 tls: certificate or key did not parse");

                    return;
                }
            }
        } else {
            None
        };

        tokio::pin!(halt);

        loop {
            let stream = tokio::select! {
                _ = &mut halt => return,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => stream,
                    Err(_) => continue,
                },
            };

            let handler = handler.clone();
            let tls = tls.clone();
            let scheme = if tls.is_some() { "https" } else { "http" };

            tokio::task::spawn_local(async move {
                match tls {
                    Some(tls) => {
                        if let Ok(stream) = tls.accept(stream).await {
                            hold(TokioIo::new(stream), handler, scheme).await;
                        }
                    }
                    None => hold(TokioIo::new(stream), handler, scheme).await,
                }
            });
        }
    }

    async fn hold<I>(io: I, handler: Handler, scheme: &'static str)
    where
        I: hyper::rt::Read + hyper::rt::Write + Unpin + 'static,
    {
        let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
            let handler = handler.clone();

            async move { answer(request, handler, scheme).await }
        });

        let _ = http2::Builder::new(LocalExec)
            .serve_connection(io, service)
            .await;
    }

    async fn answer(
        request: hyper::Request<hyper::body::Incoming>,
        handler: Handler,
        scheme: &'static str,
    ) -> Result<hyper::Response<Full<Bytes>>, std::convert::Infallible> {
        let method = request.method().to_string();
        let target = request.uri().to_string();
        let path = request.uri().path().to_string();
        let query = request.uri().query().unwrap_or("").to_string();
        let authority = request
            .uri()
            .authority()
            .map(|a| a.to_string())
            .or_else(|| {
                request
                    .headers()
                    .get(hyper::header::HOST)
                    .and_then(|h| h.to_str().ok())
                    .map(|h| h.to_string())
            })
            .unwrap_or_default();

        let mut headers = HashMap::new();

        for (name, value) in request.headers().iter() {
            headers.insert(
                name.as_str().to_lowercase(),
                value.to_str().unwrap_or("").to_string(),
            );
        }

        // the pseudo-headers, put into the SAME map the HTTP/1.1 server fills, which is what lets one handler
        // serve both and what code/native/<env>/network/http2/shared/request.tree reads
        headers.insert(":method".to_string(), method.clone());
        headers.insert(":scheme".to_string(), scheme.to_string());
        headers.insert(":authority".to_string(), authority);
        headers.insert(":path".to_string(), path.clone());
        // hyper does not expose the stream id to a service, so it is reported as 0 rather than invented
        headers.insert("x-term-stream".to_string(), "0".to_string());

        let body = match request.into_body().collect().await {
            Ok(collected) => {
                String::from_utf8_lossy(&collected.to_bytes()).to_string()
            }
            Err(_) => String::new(),
        };

        let answered = handler(Request {
            method,
            url: target,
            path,
            query,
            headers: Rc::new(RefCell::new(headers)),
            body,
            dock: Rc::new(()),
        });

        Ok(build(answered))
    }

    fn build(answered: Response) -> hyper::Response<Full<Bytes>> {
        let status = u16::try_from(answered.status).unwrap_or(500);
        let mut out = hyper::Response::builder().status(
            hyper::StatusCode::from_u16(status)
                .unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR),
        );

        for header in answered.headers.borrow().iter() {
            let Header { name, value } = header;

            // RFC 9113 forbids the connection-specific fields, and a response carrying one is malformed. The
            // Term side has `http2-clean` for this; dropping them here too means a handler that forgot still
            // produces a valid stream rather than a reset one.
            if is_connection_header(name) {
                continue;
            }

            if let (Ok(name), Ok(value)) = (
                hyper::header::HeaderName::from_bytes(name.as_bytes()),
                hyper::header::HeaderValue::from_str(value),
            ) {
                out = out.header(name, value);
            }
        }

        out.body(Full::new(Bytes::from(answered.body)))
            .unwrap_or_else(|_| hyper::Response::new(Full::new(Bytes::new())))
    }

    fn is_connection_header(name: &str) -> bool {
        matches!(
            name.to_ascii_lowercase().as_str(),
            "connection"
                | "keep-alive"
                | "proxy-connection"
                | "transfer-encoding"
                | "upgrade"
        )
    }

    // a rustls acceptor that ADVERTISES h2 over ALPN, which is the whole difference from the HTTP/1.1 one
    fn acceptor(certificate: &str, key: &str) -> Option<tokio_rustls::TlsAcceptor> {
        let chain = rustls_pemfile::certs(&mut certificate.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        let private = rustls_pemfile::private_key(&mut key.as_bytes()).ok()??;
        let mut config = tokio_rustls::rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(chain, private)
            .ok()?;
        config.alpn_protocols = vec![b"h2".to_vec()];

        Some(tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config)))
    }
}
