// Signals sent to another process: kill(2) through extern "C", as child-process.rs and signals.rs declare it, so it
// builds with a bare rustc and no crate. Reached only through the public process/signal API, which hands only an id
// from 1 to the i32 range and a signal's POSIX number.
mod signal_sender {
    // whether kill(2) took the signal: false when no process has the id (ESRCH) or this one may not signal it (EPERM)
    #[cfg(unix)]
    pub fn send(id: i64, number: i64) -> bool {
        extern "C" {
            fn kill(pid: i32, signum: i32) -> i32;
        }

        unsafe { kill(id as i32, number as i32) == 0 }
    }

    // no kill(2) off unix
    #[cfg(not(unix))]
    pub fn send(_id: i64, _number: i64) -> bool {
        false
    }
}
