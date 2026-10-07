mod signals {
    // The signals a program that owns the terminal answers (terminal-target-0006), with no crate, so it builds with a
    // bare rustc. A resize (SIGWINCH) repaints at once rather than on the next key, and SIGTERM or SIGHUP end the program
    // the way ctrl-c does, raw mode off and the cursor shown, rather than leaving the terminal raw.
    //
    // The handler only records the signal. `siginterrupt` clears SA_RESTART, which `signal` sets on macOS and on glibc,
    // so a read blocked on the terminal returns EINTR when one arrives: `read-input` answers empty text, and the rounds
    // ask `take` what woke them. The numbers are the same on macOS and Linux: SIGHUP 1, SIGTERM 15, SIGWINCH 28.
    //
    // The program runs on a thread of its own, not the main one (compile/main-entry.tree `native-main`, a thread with a
    // large stack), and the kernel hands a signal sent to the process to any thread that does not block it, most often
    // the main thread, parked in `join`. A read is interrupted only on the thread the signal lands on, so the handler
    // passes a signal that landed elsewhere on to the thread that called `watch`, the one reading the terminal.
    use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};

    // the last signal not yet taken, 0 for none
    static PENDING: AtomicI32 = AtomicI32::new(0);
    // the signal that ended the program, 0 while it runs
    static STOPPED: AtomicI32 = AtomicI32::new(0);
    // the thread that watches (a `pthread_t`, the size of a pointer on macOS and Linux), 0 before `watch`
    static WATCHER: AtomicUsize = AtomicUsize::new(0);

    const RESIZE: i32 = 28;
    const WATCHED: [i32; 3] = [1, 15, RESIZE];

    // SIGTSTP, the stop a shell's ctrl-z sends, which is not the same number everywhere
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd"))]
    const STOP: i32 = 18;
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd")))]
    const STOP: i32 = 20;

    #[cfg(unix)]
    extern "C" {
        fn signal(signum: i32, handler: usize) -> usize;
        fn siginterrupt(signum: i32, flag: i32) -> i32;
        fn kill(pid: i32, signum: i32) -> i32;
        fn getpid() -> i32;
        fn pthread_self() -> usize;
        fn pthread_kill(thread: usize, signum: i32) -> i32;
    }

    // `pthread_self` and `pthread_kill` are both safe to call in a handler
    #[cfg(unix)]
    extern "C" fn notice(signum: i32) {
        PENDING.store(signum, Ordering::SeqCst);
        if signum != RESIZE {
            STOPPED.store(signum, Ordering::SeqCst);
        }
        let watcher = WATCHER.load(Ordering::SeqCst);
        unsafe {
            if watcher != 0 && pthread_self() != watcher {
                pthread_kill(watcher, signum);
            }
        }
    }

    // start answering the signals. True when they are watched, false on a platform without them
    pub fn watch() -> bool {
        #[cfg(unix)]
        unsafe {
            WATCHER.store(pthread_self(), Ordering::SeqCst);
            for signum in WATCHED {
                signal(signum, notice as usize);
                siginterrupt(signum, 1);
            }
            return true;
        }
        #[allow(unreachable_code)]
        false
    }

    // the signal that arrived since the last ask, 0 for none
    pub fn take() -> i64 {
        PENDING.swap(0, Ordering::SeqCst) as i64
    }

    // stop this process the way ctrl-z in a shell stops it, and return once the shell resumes it (`fg`). Raw mode turns
    // the terminal's own ctrl-z into a byte, so the program sends the stop to itself, after giving the terminal back.
    // True when it was stopped and has resumed
    pub fn suspend() -> bool {
        #[cfg(unix)]
        unsafe {
            return kill(getpid(), STOP) == 0;
        }
        #[allow(unreachable_code)]
        false
    }

    // once the terminal is given back: a program a signal ended exits as a process killed by it would, 128 plus its
    // number, so a shell or a supervisor reads why it stopped
    pub fn leave() -> bool {
        let stopped = STOPPED.load(Ordering::SeqCst);
        if stopped != 0 {
            std::process::exit(128 + stopped);
        }
        true
    }
}
