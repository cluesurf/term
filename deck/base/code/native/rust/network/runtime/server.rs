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
// TWO THREADS, ONE HANDLER THREAD (item term-self-host-001-1218). A Term program runs on its own loop
// (`__term_block_on`), which is no tokio runtime, so hyper cannot run on it: `start` used to `spawn_local` the accept
// loop, which needs a LocalSet nothing had made. hyper now runs on a thread of its own, on a current-thread runtime
// inside a LocalSet, and hands each request back to the program's thread, where the handler runs, as node runs it on
// its event loop. The handler is an `Rc` and never leaves that thread. A request waits on the program's loop as a
// socket does (runtime/tcp.rs): `Dispatch` is a future the loop re-polls, noting a wake time in `__TERM_WAKE`, soon at
// first and backing off to 8 ms while no request comes.
//
// NO TERM FORM IS NAMED HERE (item 1218). This file is spliced into the emitted program as source, and a form's name
// there is not its own: loaded beside network/http, the server's `response` is `Response__in0_1`. The handler is the
// native module's `answer-plain` over the program's (network/server/plain): the request goes in as its parts, the
// response comes back as `[status, body, hex, name, value, ...]`, `hex` a bytes body (item 1326).
//
// `start` answers once the port is bound, and `stop` once it is closed (item 1206): the bind and the close both
// happen on the server thread, and both are waited on by a hand-back (`crate::__term_hand_back`).
//
// Reached only through the public network/server API. See note/project/term/stdlib/native-async-file-and-server.md.
//
// The server thread (launch, accept, hold, reply, answer) is server-thread.rs, included here and in server-serve.rs.
mod runtime {
    // runtime-include: server-thread.rs

    // the longest the loop waits between two looks for a request, in microseconds (runtime/tcp.rs QUIET_MOST)
    const QUIET_MOST: u64 = 8000;

    // a running server: how to halt its thread, how to learn it has closed its port, and the port it bound
    pub struct Running {
        halt: Option<tokio::sync::oneshot::Sender<()>>,
        closed: Option<std::sync::mpsc::Receiver<()>>,
        pub port: i64,
    }

    // A server nobody stops serves for the life of the process, as a node server does that is never closed: dropped
    // without `stop`, its halt is never sent (a dropped sender would close the channel, and the accept loop would
    // take that as the halt)
    impl Drop for Running {
        fn drop(&mut self) {
            if let Some(halt) = self.halt.take() {
                std::mem::forget(halt);
            }
        }
    }

    pub type Server = Rc<RefCell<Running>>;

    // Bind the port and start answering, WITHOUT blocking: answers once the port is bound
    pub async fn start(
        port: i64,
        host: String,
        handler: Handler,
        secure: bool,
        certificate: String,
        key: String,
    ) -> Server {
        let launched =
            crate::__term_hand_back(move || launch(port, host, secure, certificate, key)).await;

        match launched {
            Ok(bound) => {
                crate::__term_spawn(Dispatch {
                    asked: bound.asked,
                    handler,
                    tries: 0,
                });

                Rc::new(RefCell::new(Running {
                    halt: Some(bound.halt),
                    closed: Some(bound.closed),
                    port: bound.port,
                }))
            }
            Err(error) => {
                eprintln!("{}", error);

                Rc::new(RefCell::new(Running {
                    halt: None,
                    closed: None,
                    port,
                }))
            }
        }
    }

    // the port a started server is bound to: the OS's choice when `start` asked for port 0 (item 1326)
    pub fn port(server: Server) -> i64 {
        server.borrow().port
    }

    // stop accepting, and answer once the server thread has closed its listener and every connection
    pub async fn stop(server: Server) {
        let (halt, closed) = {
            let mut running = server.borrow_mut();
            (running.halt.take(), running.closed.take())
        };

        if let Some(halt) = halt {
            let _ = halt.send(());
        }

        if let Some(closed) = closed {
            crate::__term_hand_back(move || {
                let _ = closed.recv();
            })
            .await;
        }
    }

    // the requests the server thread hands back, each answered on the program's thread. Ends when the server thread
    // has ended, which drops the last sender
    struct Dispatch {
        asked: std::sync::mpsc::Receiver<Asked>,
        handler: Handler,
        tries: u32,
    }

    impl std::future::Future for Dispatch {
        type Output = ();

        fn poll(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<()> {
            let this = self.get_mut();

            loop {
                match this.asked.try_recv() {
                    Ok(asked) => {
                        this.tries = 0;
                        crate::__term_progressed();
                        answer(&this.handler, asked);
                    }
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        crate::__term_progressed();

                        return std::task::Poll::Ready(());
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => {
                        // the first look again on the next round, then 50 us doubling up to QUIET_MOST
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
                }
            }
        }
    }

}
