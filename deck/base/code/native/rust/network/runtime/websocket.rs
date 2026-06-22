// WebSocket client runtime over tokio-tungstenite. The opaque handle a seed socket holds is an Arc<Mutex<WebSocketStream>>
// (Arc so the handle is Clone, which every emitted struct derives; the Mutex guards the single stream that both send and
// receive borrow mutably). The stream buffers frames at the socket level, so receive pulls the next one with no message-
// loss race. receive returns the seed `message` form. Reached only through the public WebSocket API.
mod websocket {
    use super::Message;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::Arc;
    use tokio::net::TcpStream;
    use tokio::sync::Mutex;
    use tokio_tungstenite::tungstenite::Message as WsMessage;
    use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

    type Handle = Arc<Mutex<WebSocketStream<MaybeTlsStream<TcpStream>>>>;

    pub async fn connect(url: String) -> Handle {
        let (stream, _) = connect_async(&url).await.expect("websocket connect");
        Arc::new(Mutex::new(stream))
    }

    pub async fn send(handle: Handle, data: String) {
        let mut guard = handle.lock().await;
        let _ = guard.send(WsMessage::Text(data.into())).await;
    }

    pub async fn receive(handle: Handle) -> Message {
        let mut guard = handle.lock().await;
        match guard.next().await {
            Some(Ok(WsMessage::Text(text))) => Message {
                kind: "text".to_string(),
                data: text.to_string(),
            },
            _ => Message {
                kind: "close".to_string(),
                data: String::new(),
            },
        }
    }

    pub async fn close(handle: Handle) {
        let mut guard = handle.lock().await;
        let _ = guard.close(None).await;
    }
}
