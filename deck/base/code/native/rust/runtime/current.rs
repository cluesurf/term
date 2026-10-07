// Current-process runtime. Each of these is an iterator chain or a Result unwrap in Rust, neither of which the seed
// source can express, so they are reduced here to plain values. Reached only through the public process API.
mod current {
    pub fn id() -> i64 {
        std::process::id() as i64
    }

    // the seed list representation: a reference-counted mutable vec
    pub fn arguments() -> std::rc::Rc<std::cell::RefCell<Vec<String>>> {
        // the program's own arguments, as on every backend: the first is the program
        std::rc::Rc::new(std::cell::RefCell::new(std::env::args().skip(1).collect()))
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
        // the numbers are the same on macOS and Linux: SIGHUP 1, SIGINT 2, SIGTERM 15
        let number: i32 = match signal.as_str() {
            "terminate" => 15,
            "interrupt" => 2,
            "hangup" => 1,
            _ => return,
        };

        // signal(2) through extern "C", as signals.rs does, so it builds with a bare rustc and no crate
        #[cfg(unix)]
        {
            extern "C" {
                fn signal(signum: i32, handler: usize) -> usize;
            }

            // the handler is an Rc closure, so not Send by construction. The emitted program is
            // single threaded, and registration keeps the closure alive for the process lifetime,
            // so asserting Send/Sync on the table is sound here.
            struct Trampoline(std::rc::Rc<dyn Fn()>);
            unsafe impl Send for Trampoline {}
            unsafe impl Sync for Trampoline {}

            // one handler per signal, a later listen replacing an earlier one
            static HANDLERS: std::sync::Mutex<Vec<(i32, Trampoline)>> = std::sync::Mutex::new(Vec::new());

            extern "C" fn notice(signum: i32) {
                // a handler that lands while the table is being changed is dropped, not waited for
                if let Ok(table) = HANDLERS.try_lock() {
                    if let Some((_, trampoline)) = table.iter().find(|(known, _)| *known == signum) {
                        (trampoline.0)();
                    }
                }
            }

            if let Ok(mut table) = HANDLERS.lock() {
                table.retain(|(known, _)| *known != number);
                table.push((number, Trampoline(handler)));
            }
            unsafe {
                signal(number, notice as usize);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = (number, handler);
        }
    }
}
