// HTTP server runtime for the rust target, over hyper on tokio -- the ecosystem's HTTP implementation, not an
// accept loop of our own.
//
// WHAT THE HAND-ROLLED LOOP DID NOT DO. The previous shim read up to 8192 bytes with one `read`, took whatever
// came as the whole request, and closed the connection after answering. So: no keep-alive, no HTTP/2, no chunked
// or streamed body, a body larger than the first packet silently truncated, a body split across packets silently
// lost, and no TLS at all. hyper does all of that, and it is what every rust server in production sits on.
//
// axum was the other candidate and is not used: it is a router, and the Term API already owns routing
// (network/server/route, and the `dock` routing DSL that lowers to a dispatcher). hyper is the layer this
// actually sits at, and it is what axum is built on.
//
// ONE THREAD, DELIBERATELY. The handler a Term program hands in is an `Rc<dyn Fn(Request) -> Response>`, which is
// what the compiler emits for a task value, and an Rc cannot cross a thread. So the server runs on a
// current-thread runtime inside a LocalSet and every connection is a `spawn_local`. Connections are still
// concurrent (that is what the runtime is for), they are just not parallel. Making them parallel means making
// emitted task values Send, which is a compiler change and its own piece of work.
//
// Reached only through the public network/server API. See note/term/stdlib/native-async-file-and-server.md.
mod runtime {
    use super::{Header, Request, Response};
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;
    use tokio::net::TcpListener;

    pub type Handler = Rc<dyn Fn(Request) -> Response>;

    // a running server: how to tell the accept loop to stop, plus the port it actually bound (which is the one
    // the caller asked for, or the one the system chose when they asked for 0)
    pub struct Running {
        pub stop: Option<tokio::sync::oneshot::Sender<()>>,
        pub port: i64,
    }

    pub type Server = Rc<RefCell<Running>>;

    // Run the server and block for the life of the process: the entry point of a server binary. This is the one
    // that builds the runtime, so a Term program does not need a `#[tokio::main]` of its own.
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
            .expect("server runtime");
        let local = tokio::task::LocalSet::new();

        local.block_on(&runtime, async move {
            // The sender is HELD, not dropped. Bound to `_` it is dropped at the end of the statement, which
            // closes the channel, which makes the receiver resolve, which makes the `select!` in `accept` take
            // the shutdown arm on its first poll. The server then exits cleanly and instantly, having served
            // nothing, printing nothing: `serve` returns and `main` ends. That is what a one-character binding
            // costs here.
            let (keep, forever) = tokio::sync::oneshot::channel::<()>();
            accept(port, host, handler, secure, certificate, key, forever).await;
            drop(keep);
        });
    }

    // Bind the port and start answering, WITHOUT blocking. Must be called from inside a LocalSet, for the reason
    // in the header: the handler is an Rc and the accept loop is a `spawn_local`.
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

    // the accept loop, until `halt` fires
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
                eprintln!("server bind {}:{}: {}", host, port, error);

                return;
            }
        };

        let tls = if secure {
            match acceptor(&certificate, &key) {
                Some(acceptor) => Some(acceptor),
                None => {
                    eprintln!("server tls: certificate or key did not parse");

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

            tokio::task::spawn_local(async move {
                match tls {
                    Some(tls) => match tls.accept(stream).await {
                        Ok(stream) => hold(TokioIo::new(stream), handler).await,
                        Err(_) => {}
                    },
                    None => hold(TokioIo::new(stream), handler).await,
                }
            });
        }
    }

    // one connection, for as many requests as the client keeps it open for
    async fn hold<I>(io: I, handler: Handler)
    where
        I: hyper::rt::Read + hyper::rt::Write + Unpin + 'static,
    {
        let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
            let handler = handler.clone();

            async move { answer(request, handler).await }
        });

        // no `with_upgrades`: a websocket upgrade is the websocket module's job, not this one's
        let _ = http1::Builder::new()
            .keep_alive(true)
            .serve_connection(io, service)
            .await;
    }

    async fn answer(
        request: hyper::Request<hyper::body::Incoming>,
        handler: Handler,
    ) -> Result<hyper::Response<Full<Bytes>>, std::convert::Infallible> {
        let method = request.method().to_string();
        let target = request.uri().to_string();
        let path = request.uri().path().to_string();
        let query = request.uri().query().unwrap_or("").to_string();

        let mut headers = HashMap::new();

        for (name, value) in request.headers().iter() {
            headers.insert(
                name.as_str().to_lowercase(),
                value.to_str().unwrap_or("").to_string(),
            );
        }

        // the WHOLE body, however many packets it arrived in and whether or not it was chunked. The old shim
        // took the first read and called it the body.
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
        let mut out = hyper::Response::builder()
            .status(hyper::StatusCode::from_u16(status).unwrap_or(
                hyper::StatusCode::INTERNAL_SERVER_ERROR,
            ));

        // appended, not inserted, so repeats survive: several set-cookie headers is the ordinary case and the
        // reason the Term response holds a LIST of headers rather than a map
        for header in answered.headers.borrow().iter() {
            let Header { name, value } = header;

            if let (Ok(name), Ok(value)) = (
                hyper::header::HeaderName::from_bytes(name.as_bytes()),
                hyper::header::HeaderValue::from_str(value),
            ) {
                out = out.header(name, value);
            }
        }

        out.body(Full::new(Bytes::from(answered.body)))
            .unwrap_or_else(|_| {
                hyper::Response::new(Full::new(Bytes::new()))
            })
    }

    // a rustls acceptor from PEM text, which is how the Term API takes a certificate and a key
    fn acceptor(
        certificate: &str,
        key: &str,
    ) -> Option<tokio_rustls::TlsAcceptor> {
        let chain = rustls_pemfile::certs(&mut certificate.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        let private = rustls_pemfile::private_key(&mut key.as_bytes()).ok()??;
        let config = tokio_rustls::rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(chain, private)
            .ok()?;

        Some(tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config)))
    }
}
