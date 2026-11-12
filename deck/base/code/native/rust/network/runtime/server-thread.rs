// The rust HTTP server's thread, written into both server shims (network/runtime/server.rs `mod runtime`, and
// network/runtime/server-serve.rs `mod serving`) by their `// runtime-include:` line, so each module has its own copy
// and a program that loads both builds. Nothing here names the program's executor: `serve` reaches it from a program
// that has none. Item term-self-host-001-1218; the design is in server.rs's header.
    use bytes::Bytes;
    use http_body_util::{BodyExt, Full};
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use std::cell::RefCell;
    use crate::TermMap;
    use std::rc::Rc;

    type Texts = Rc<RefCell<Vec<String>>>;
    type Headers = Rc<RefCell<TermMap<String, String>>>;

    // network/server/plain `answer-plain` over the program's handler: method, url, path, query, headers, body, dock
    pub type Handler =
        Rc<dyn Fn(String, String, String, String, Headers, String, Rc<dyn std::any::Any>) -> Texts>;

    // one request, handed from the server thread to the program's, and the way its answer goes back
    struct Asked {
        method: String,
        url: String,
        path: String,
        query: String,
        headers: Vec<(String, String)>,
        body: String,
        reply: tokio::sync::oneshot::Sender<Answer>,
    }

    struct Answer {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
    }

    // what the server thread hands back once its port is bound
    struct Bound {
        halt: tokio::sync::oneshot::Sender<()>,
        closed: std::sync::mpsc::Receiver<()>,
        asked: std::sync::mpsc::Receiver<Asked>,
    }

    // one request answered by the program's handler, on the program's thread
    fn answer(handler: &Handler, asked: Asked) {
        let mut headers = TermMap::new();

        for (name, value) in asked.headers {
            headers.insert(name, value);
        }

        let said = handler(
            asked.method,
            asked.url,
            asked.path,
            asked.query,
            Rc::new(RefCell::new(headers)),
            asked.body,
            Rc::new(()),
        );
        let said = said.borrow();
        let status = said
            .first()
            .and_then(|status| status.trim().parse::<f64>().ok())
            .filter(|status| *status >= 100.0 && *status <= 999.0)
            .map(|status| status as u16)
            .unwrap_or(500);
        let body = said.get(1).cloned().unwrap_or_default();
        let mut pairs = Vec::new();
        let mut at = 2;

        while at + 1 < said.len() {
            pairs.push((said[at].clone(), said[at + 1].clone()));
            at += 2;
        }

        let _ = asked.reply.send(Answer {
            status,
            headers: pairs,
            body,
        });
    }

    // the server thread: bound before this answers, so a caller's `start` answers with the port taken
    fn launch(
        port: i64,
        host: String,
        secure: bool,
        certificate: String,
        key: String,
    ) -> Result<Bound, String> {
        let tls = if secure {
            match acceptor(&certificate, &key) {
                Some(acceptor) => Some(acceptor),
                None => return Err("server tls: certificate or key did not parse".to_string()),
            }
        } else {
            None
        };

        let (ready, readied) = std::sync::mpsc::channel::<Result<(), String>>();
        let (halt, halted) = tokio::sync::oneshot::channel::<()>();
        let (close, closed) = std::sync::mpsc::channel::<()>();
        let (ask, asked) = std::sync::mpsc::channel::<Asked>();

        let spawned = std::thread::Builder::new()
            .name("term-server".to_string())
            .spawn(move || {
                // the runtime and the LocalSet are dropped before `close` is sent: that closes every connection
                // still open, kept-alive ones included, so the port is free when `stop` answers
                {
                    let runtime = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(runtime) => runtime,
                        Err(error) => {
                            let _ = ready.send(Err(format!("server runtime: {}", error)));
                            let _ = close.send(());

                            return;
                        }
                    };
                    let local = tokio::task::LocalSet::new();

                    local.block_on(&runtime, async move {
                        // tokio's bind sets SO_REUSEADDR on unix, as node's listen does
                        let listener =
                            match tokio::net::TcpListener::bind(format!("{}:{}", host, port)).await {
                                Ok(listener) => listener,
                                Err(error) => {
                                    let _ = ready
                                        .send(Err(format!("server bind {}:{}: {}", host, port, error)));

                                    return;
                                }
                            };
                        let _ = ready.send(Ok(()));

                        accept(listener, tls, ask, halted).await;
                    });

                    drop(local);
                    drop(runtime);
                }

                let _ = close.send(());
            });

        if let Err(error) = spawned {
            return Err(format!("server thread: {}", error));
        }

        match readied.recv() {
            Ok(Ok(())) => Ok(Bound {
                halt,
                closed,
                asked,
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("server thread ended before it bound".to_string()),
        }
    }

    // the accept loop, until `halt` fires. The listener is dropped as it returns
    async fn accept(
        listener: tokio::net::TcpListener,
        tls: Option<tokio_rustls::TlsAcceptor>,
        ask: std::sync::mpsc::Sender<Asked>,
        halt: tokio::sync::oneshot::Receiver<()>,
    ) {
        tokio::pin!(halt);

        loop {
            let stream = tokio::select! {
                _ = &mut halt => return,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => stream,
                    Err(_) => continue,
                },
            };

            let ask = ask.clone();
            let tls = tls.clone();

            tokio::task::spawn_local(async move {
                match tls {
                    Some(tls) => match tls.accept(stream).await {
                        Ok(stream) => hold(TokioIo::new(stream), ask).await,
                        Err(_) => {}
                    },
                    None => hold(TokioIo::new(stream), ask).await,
                }
            });
        }
    }

    // one connection, for as many requests as the client keeps it open for
    async fn hold<I>(io: I, ask: std::sync::mpsc::Sender<Asked>)
    where
        I: hyper::rt::Read + hyper::rt::Write + Unpin + 'static,
    {
        let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
            let ask = ask.clone();

            async move { reply(request, ask).await }
        });

        // no `with_upgrades`: a websocket upgrade is the websocket module's job, not this one's
        let _ = http1::Builder::new()
            .keep_alive(true)
            .serve_connection(io, service)
            .await;
    }

    // one request read whole, handed to the program's thread, and its answer written
    async fn reply(
        request: hyper::Request<hyper::body::Incoming>,
        ask: std::sync::mpsc::Sender<Asked>,
    ) -> Result<hyper::Response<Full<Bytes>>, std::convert::Infallible> {
        let method = request.method().to_string();
        let url = request.uri().to_string();
        let path = request.uri().path().to_string();
        let query = request.uri().query().unwrap_or("").to_string();
        let headers = request
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_lowercase(),
                    value.to_str().unwrap_or("").to_string(),
                )
            })
            .collect();

        // the WHOLE body, however many packets it arrived in and whether or not it was chunked. The old shim
        // took the first read and called it the body.
        let body = match request.into_body().collect().await {
            Ok(collected) => String::from_utf8_lossy(&collected.to_bytes()).to_string(),
            Err(_) => String::new(),
        };

        let (answered, answer) = tokio::sync::oneshot::channel::<Answer>();
        let sent = ask.send(Asked {
            method,
            url,
            path,
            query,
            headers,
            body,
            reply: answered,
        });

        let said = match sent {
            Ok(()) => answer.await.ok(),
            Err(_) => None,
        };

        Ok(match said {
            Some(said) => build(said),
            None => bare(503),
        })
    }

    fn bare(status: u16) -> hyper::Response<Full<Bytes>> {
        let mut out = hyper::Response::new(Full::new(Bytes::new()));
        *out.status_mut() = hyper::StatusCode::from_u16(status)
            .unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR);

        out
    }

    fn build(answered: Answer) -> hyper::Response<Full<Bytes>> {
        let mut out = hyper::Response::builder().status(
            hyper::StatusCode::from_u16(answered.status)
                .unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR),
        );

        // appended, not inserted, so repeats survive: several set-cookie headers is the ordinary case and the
        // reason the Term response holds a LIST of headers rather than a map
        for (name, value) in answered.headers.iter() {
            if let (Ok(name), Ok(value)) = (
                hyper::header::HeaderName::from_bytes(name.as_bytes()),
                hyper::header::HeaderValue::from_str(value),
            ) {
                out = out.header(name, value);
            }
        }

        out.body(Full::new(Bytes::from(answered.body)))
            .unwrap_or_else(|_| bare(500))
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
