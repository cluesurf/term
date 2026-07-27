mod clock {
    pub fn current_time() -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }
    pub fn sleep(ms: i64) { std::thread::sleep(std::time::Duration::from_millis(ms as u64)); }
}
