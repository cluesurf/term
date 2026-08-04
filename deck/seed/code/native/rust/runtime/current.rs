// Current-process runtime. Each of these is an iterator chain or a Result unwrap in Rust, neither of which the seed
// source can express, so they are reduced here to plain values. Reached only through the public process API.
mod current {
    pub fn id() -> i64 {
        std::process::id() as i64
    }

    pub fn arguments() -> Vec<String> {
        std::env::args().collect()
    }

    pub fn directory() -> String {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    pub fn executable() -> String {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    pub fn exit(code: i64) -> ! {
        std::process::exit(code as i32)
    }

    // `signal` is one of "terminate", "interrupt", "hangup"; anything else is ignored
    pub fn listen(signal: String, handler: fn()) {
        let number = match signal.as_str() {
            "terminate" => libc::SIGTERM,
            "interrupt" => libc::SIGINT,
            "hangup" => libc::SIGHUP,
            _ => return,
        };

        unsafe {
            let _ = signal_hook::low_level::register(number, handler);
        }
    }
}
