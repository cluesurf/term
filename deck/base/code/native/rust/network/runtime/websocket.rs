// WebSocket client runtime over tungstenite and a std::net TcpStream. The opaque handle a seed socket holds is an
// Arc<Mutex<WebSocket>> (Arc so the handle is Clone, which every emitted struct derives; the Mutex guards the single
// stream that both send and receive borrow mutably, and is only ever held inside one poll). The stream buffers frames
// at the socket level, so receive pulls the next one with no message-loss race. receive returns the seed `message`
// form. Reached only through the public WebSocket API.
//
// A socket wait holds no pool worker and needs no tokio reactor (item 1154, the shape of tcp.rs after 1151 and 1156).
// The connect, which ends on its own (the TCP connect and the opening handshake), is HANDED BACK
// (note/project/term/decision/001-native-work-hands-back-to-the-loop.md) through `crate::__term_hand_back`. After it the
// socket is non-blocking, and each send, receive and close is a future the program's loop re-polls: an attempt that
// would block answers pending and notes a wake time in the loop's `__TERM_WAKE`, as a timer does (the next round at
// first, then 50 us doubling to 8 ms while the socket stays quiet), so `__term_block_on` sleeps until then and polls
// again rather than stopping with the defect or spinning. A finished attempt calls `crate::__term_progressed`.
// tokio-tungstenite's connect_async needed a tokio reactor, which Term's own loop does not have, so the first connect
// of any program built as `term make --build` builds panicked.
mod websocket {
    use super::Message;
    use std::net::TcpStream;
    use std::sync::{Arc, Mutex};
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::{Error, Message as WsMessage, WebSocket};

    type Handle = Arc<Mutex<WebSocket<MaybeTlsStream<TcpStream>>>>;

    // the longest a quiet socket waits between two attempts, in microseconds
    const QUIET_MOST: u64 = 8000;

    // one socket step retried each time the loop polls it: None while it would block, Some once it is done
    struct Attempt<T, F: FnMut() -> Option<T> + Unpin> {
        call: F,
        tries: u32,
    }

    impl<T, F: FnMut() -> Option<T> + Unpin> std::future::Future for Attempt<T, F> {
        type Output = T;
        fn poll(self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<T> {
            let this = self.get_mut();
            match (this.call)() {
                Some(answer) => {
                    crate::__term_progressed();
                    std::task::Poll::Ready(answer)
                }
                None => {
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
                    std::task::Poll::Pending
                }
            }
        }
    }

    fn attempt<T, F: FnMut() -> Option<T> + Unpin>(call: F) -> Attempt<T, F> {
        Attempt { call, tries: 0 }
    }

    // a step that would block, or was interrupted, is tried again
    fn waits(error: &Error) -> bool {
        match error {
            Error::Io(error) => matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            ),
            _ => false,
        }
    }

    fn closed() -> Message {
        Message {
            kind: "close".to_string(),
            data: String::new(),
        }
    }

    // the connect and the opening handshake end on their own, so they block a pool worker until they do. A wss:// url
    // is refused, as tokio-tungstenite's connect_async with no TLS feature refused it
    pub async fn connect(url: String) -> Handle {
        let socket = crate::__term_hand_back(move || {
            let (socket, _) = tungstenite::connect(url.as_str()).map_err(|error| error.to_string())?;
            match socket.get_ref() {
                MaybeTlsStream::Plain(stream) => {
                    stream.set_nonblocking(true).map_err(|error| error.to_string())?
                }
                _ => return Err("websocket: not a plain stream".to_string()),
            }
            Ok::<WebSocket<MaybeTlsStream<TcpStream>>, String>(socket)
        })
        .await
        .expect("websocket connect");
        Arc::new(Mutex::new(socket))
    }

    // queue the text frame, then flush until the socket has taken all of it. An error ends the send quietly, as
    // tokio-tungstenite's send did
    pub async fn send(handle: Handle, data: String) {
        let mut message = Some(WsMessage::Text(data));
        attempt(move || {
            let mut socket = match handle.lock() {
                Ok(socket) => socket,
                Err(_) => return Some(()),
            };
            if let Some(next) = message.take() {
                match socket.write(next) {
                    Ok(()) => {}
                    // the frame is queued, and the flush below goes on writing it
                    Err(error) if waits(&error) => {}
                    // the write buffer is full: the frame comes back, to be written once a flush has made room
                    Err(Error::WriteBufferFull(back)) => message = Some(back),
                    Err(_) => return Some(()),
                }
            }
            match socket.flush() {
                Ok(()) if message.is_none() => Some(()),
                Ok(()) => None,
                Err(error) if waits(&error) => None,
                Err(_) => Some(()),
            }
        })
        .await
    }

    // the next text frame, or the close form for a close, the end, an error or any other frame, as before
    pub async fn receive(handle: Handle) -> Message {
        attempt(move || {
            let mut socket = match handle.lock() {
                Ok(socket) => socket,
                Err(_) => return Some(closed()),
            };
            match socket.read() {
                Ok(WsMessage::Text(text)) => Some(Message {
                    kind: "text".to_string(),
                    data: text,
                }),
                Err(error) if waits(&error) => None,
                _ => Some(closed()),
            }
        })
        .await
    }

    // queue the close frame and flush it, without waiting for the peer's own close, as tokio-tungstenite's close did
    pub async fn close(handle: Handle) {
        let mut queued = false;
        attempt(move || {
            let mut socket = match handle.lock() {
                Ok(socket) => socket,
                Err(_) => return Some(()),
            };
            let step = if queued {
                socket.flush()
            } else {
                queued = true;
                socket.close(None)
            };
            match step {
                Err(error) if waits(&error) => None,
                _ => Some(()),
            }
        })
        .await
    }
}
