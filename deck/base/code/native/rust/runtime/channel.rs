// Text channel runtime over tokio's unbounded mpsc. The opaque handle a seed channel holds is a SeedChannel pairing the
// sender (Clone, multi-producer) with an Arc<Mutex<receiver>> (the single consumer, shareable through the Clone-derived
// struct). send never blocks (unbounded); receive awaits the next value. Reached only through the public channel API.
mod channel {
    use std::sync::Arc;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
    use tokio::sync::Mutex;

    #[derive(Clone)]
    pub struct SeedChannel {
        sender: UnboundedSender<String>,
        receiver: Arc<Mutex<UnboundedReceiver<String>>>,
    }

    pub fn make() -> SeedChannel {
        let (sender, receiver) = unbounded_channel();
        SeedChannel {
            sender,
            receiver: Arc::new(Mutex::new(receiver)),
        }
    }

    pub async fn send(target: SeedChannel, item: String) {
        let _ = target.sender.send(item);
    }

    pub async fn receive(source: SeedChannel) -> String {
        let mut guard = source.receiver.lock().await;
        guard.recv().await.unwrap_or_default()
    }

    pub async fn close(_target: SeedChannel) {}
}
