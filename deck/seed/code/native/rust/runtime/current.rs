// Current-process runtime. Each of these is an iterator chain or a Result unwrap in Rust, neither of which the seed
// source can express, so they are reduced here to plain values. Reached only through the public process API.
mod current {
    pub fn id() -> i64 {
        std::process::id() as i64
    }

    // the seed list representation: a reference-counted mutable vec
    pub fn arguments() -> std::rc::Rc<std::cell::RefCell<Vec<String>>> {
        std::rc::Rc::new(std::cell::RefCell::new(std::env::args().collect()))
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
    pub fn listen(signal: String, handler: std::rc::Rc<dyn Fn()>) {
        let number = match signal.as_str() {
            "terminate" => libc::SIGTERM,
            "interrupt" => libc::SIGINT,
            "hangup" => libc::SIGHUP,
            _ => return,
        };

        // the handler is an Rc closure, so not Send by construction. The emitted program is
        // single threaded, and registration keeps the closure alive for the process lifetime,
        // so asserting Send/Sync on the trampoline is sound here.
        struct Trampoline(std::rc::Rc<dyn Fn()>);
        unsafe impl Send for Trampoline {}
        unsafe impl Sync for Trampoline {}
        impl Trampoline {
            // a method call captures the whole struct in the closure below; a bare field read
            // would capture only the non-Send field and lose the Send/Sync assertion
            fn call(&self) {
                (self.0)()
            }
        }
        let trampoline = Trampoline(handler);
        unsafe {
            let _ = signal_hook::low_level::register(number, move || trampoline.call());
        }
    }
}
