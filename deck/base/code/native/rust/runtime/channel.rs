// Channel runtime over a queue the program's one loop owns. The opaque handle a seed channel holds is a SeedChannel,
// an Rc'd buffer of messages (Clone, so every holder shares the one queue). A message is any Term value, boxed as the
// unknown (`Rc<dyn Any>`): the public `channel` form is what types it, by a downcast on the way out. send never blocks
// (unbounded); receive waits for the next value. Reached only through the public channel API.
//
// The queue is the loop's own (note/project/term/decision/001-native-work-hands-back-to-the-loop.md), never a tokio
// channel. `__term_block_on` polls every waiting future each round with a no-op waker and stops with the defect when a
// round ends no wait. A tokio receive that took a message counted nothing, so two jobs passing messages back and forth
// stopped there although each round moved a message (item 1155). A receive here counts as an ended wait.
mod channel {
    use std::any::Any;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    #[derive(Clone)]
    pub struct SeedChannel {
        queue: Rc<RefCell<VecDeque<Rc<dyn Any>>>>,
    }

    pub fn make() -> SeedChannel {
        SeedChannel {
            queue: Rc::new(RefCell::new(VecDeque::new())),
        }
    }

    pub async fn send(target: SeedChannel, item: Rc<dyn Any>) {
        target.queue.borrow_mut().push_back(item);
    }

    // the next message, once one is queued: re-polled by the loop each round until then
    struct Next {
        source: SeedChannel,
    }

    impl std::future::Future for Next {
        type Output = Rc<dyn Any>;
        fn poll(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Rc<dyn Any>> {
            let item = self.source.queue.borrow_mut().pop_front();
            match item {
                Some(item) => {
                    crate::__term_progressed();
                    std::task::Poll::Ready(item)
                }
                None => {
                    cx.waker().wake_by_ref();
                    std::task::Poll::Pending
                }
            }
        }
    }

    // a receive nothing ever sends to waits for ever, so the loop reports it as a wait nothing can finish
    pub async fn receive(source: SeedChannel) -> Rc<dyn Any> {
        Next { source }.await
    }

    pub async fn close(_target: SeedChannel) {}
}
