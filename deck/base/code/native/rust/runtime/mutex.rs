// Mutex runtime: an atomic spinlock with cooperative yield, shared through an Arc (so the Clone-derived seed struct holds
// it, and lock / unlock are separate calls without a lifetime-bound guard). Reached only through the public mutex API.
mod mutex {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    pub fn make() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }
    pub async fn lock(handle: Arc<AtomicBool>) {
        while handle
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            tokio::task::yield_now().await;
        }
    }
    pub async fn unlock(handle: Arc<AtomicBool>) {
        handle.store(false, Ordering::Release);
    }
}
