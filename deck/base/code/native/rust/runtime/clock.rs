// Clock runtime. `now` is the wall clock in milliseconds; `precise` is the monotonic timer, which is immune to the
// clock being adjusted and so is the one to measure durations with. Reached only through the public clock API.
mod clock {
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    pub fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_millis() as i64)
            .unwrap_or(0)
    }

    // Monotonic, counted from the first call. `Instant` has no epoch to report, so the zero point is process
    // start rather than boot: what a monotonic clock is FOR is subtracting two readings, and any fixed zero does
    // that correctly.
    pub fn precise() -> i64 {
        use std::sync::OnceLock;

        static FROM: OnceLock<Instant> = OnceLock::new();
        let from = FROM.get_or_init(Instant::now);

        from.elapsed().as_millis() as i64
    }

    // whole nanoseconds since the first call to this function, never decreasing. A separate origin from `precise`, so
    // the first read is zero whichever clock the program read first
    pub fn nanoseconds() -> i64 {
        use std::sync::OnceLock;

        static FROM: OnceLock<Instant> = OnceLock::new();
        let from = FROM.get_or_init(Instant::now);

        from.elapsed().as_nanos() as i64
    }

    // what `clock/now` reads: monotonic milliseconds on every backend (note/term/stdlib/semantics.md). The wall
    // clock is `time/now`
    pub fn current_time() -> i64 {
        precise()
    }

    pub fn sleep(ms: i64) {
        std::thread::sleep(std::time::Duration::from_millis(ms.max(0) as u64));
    }
}
