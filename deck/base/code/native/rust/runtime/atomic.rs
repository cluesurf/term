// Atomic integer runtime over std AtomicI64, shared through an Arc so the Clone-derived seed struct can hold it. Reached
// only through the public atomic API.
mod atomic {
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;
    pub fn make(initial: i64) -> Arc<AtomicI64> {
        Arc::new(AtomicI64::new(initial))
    }
    pub fn load(cell: Arc<AtomicI64>) -> i64 {
        cell.load(Ordering::SeqCst)
    }
    pub fn store(cell: Arc<AtomicI64>, value: i64) {
        cell.store(value, Ordering::SeqCst);
    }
    pub fn increase(cell: Arc<AtomicI64>, delta: i64) -> i64 {
        cell.fetch_add(delta, Ordering::SeqCst) + delta
    }
}
