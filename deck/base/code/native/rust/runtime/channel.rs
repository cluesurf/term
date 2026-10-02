// Channel runtime over tokio's unbounded mpsc. The opaque handle a seed channel holds is a SeedChannel pairing the
// sender (Clone, multi-producer) with an Rc<Mutex<receiver>> (the single consumer, shareable through the Clone-derived
// struct). A message is any Term value, boxed as the unknown (`Rc<dyn Any>`): the public `channel` form is what types
// it, by a downcast on the way out. send never blocks (unbounded); receive awaits the next value. Reached only through
// the public channel API.
mod channel {
    use std::any::Any;
    use std::rc::Rc;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
    use tokio::sync::Mutex;

    #[derive(Clone)]
    pub struct SeedChannel {
        sender: UnboundedSender<Rc<dyn Any>>,
        receiver: Rc<Mutex<UnboundedReceiver<Rc<dyn Any>>>>,
    }

    pub fn make() -> SeedChannel {
        let (sender, receiver) = unbounded_channel();
        SeedChannel {
            sender,
            receiver: Rc::new(Mutex::new(receiver)),
        }
    }

    pub async fn send(target: SeedChannel, item: Rc<dyn Any>) {
        let _ = target.sender.send(item);
    }

    // every sender is held by the channel itself, so the queue never closes while a receiver waits; the unit is
    // unreachable rather than a default anyone can see
    pub async fn receive(source: SeedChannel) -> Rc<dyn Any> {
        let mut guard = source.receiver.lock().await;
        guard.recv().await.unwrap_or_else(|| Rc::new(()))
    }

    pub async fn close(_target: SeedChannel) {}
}
