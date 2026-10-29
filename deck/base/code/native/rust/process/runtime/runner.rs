// Subprocess runner over std::process::Command. Runs the command to completion, capturing stdout and stderr, and
// returns the exit code with both streams. A spawn failure returns code -1 and the error text, so the public run API
// stays total. A child a signal ended answers code 128 plus the signal's number and `signal` that number; one that
// exited by itself answers its code and signal 0. `directory` (empty is this process's own) and `environment`
// (entries added over the inherited one) shape the child; a directory that is not there fails the spawn, as a missing
// command does. Reached only through the public run API.
mod runner {
    use super::RunResult;

    type Environment = std::rc::Rc<std::cell::RefCell<crate::TermMap<String, String>>>;

    // the command with its arguments, working directory and added variables
    fn shaped(
        command: &str,
        argument_list: &std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        directory: &str,
        environment: &Environment,
    ) -> std::process::Command {
        let mut shaped = std::process::Command::new(command);
        shaped.args(argument_list.borrow().iter());
        if !directory.is_empty() {
            shaped.current_dir(directory);
        }
        for (name, value) in environment.borrow().iter() {
            shaped.env(name.as_str(), value.as_str());
        }
        shaped
    }

    // the exit code a status answers and its signal: a signal death is 128 plus the signal, an exit by itself is its
    // own code and signal 0
    fn finished(status: std::process::ExitStatus) -> (i64, i64) {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(signal) = status.signal() {
                return (128 + signal as i64, signal as i64);
            }
        }
        (status.code().unwrap_or(0) as i64, 0)
    }

    fn answered(out: std::process::Output) -> RunResult {
        let (code, signal) = finished(out.status);
        RunResult {
            code,
            output: String::from_utf8_lossy(&out.stdout).to_string(),
            error: String::from_utf8_lossy(&out.stderr).to_string(),
            signal,
        }
    }

    fn refused(cause: std::io::Error) -> RunResult {
        RunResult { code: -1, output: String::new(), error: cause.to_string(), signal: 0 }
    }

    // a signal sent to the child, with no crate (the numbers are the same on macOS and Linux: SIGKILL 9, SIGTERM 15).
    // Off unix only the kill there is
    #[cfg(unix)]
    fn signal_child(child: &mut std::process::Child, signum: i32) {
        extern "C" {
            fn kill(pid: i32, signum: i32) -> i32;
        }
        unsafe { kill(child.id() as i32, signum) };
    }

    #[cfg(not(unix))]
    fn signal_child(child: &mut std::process::Child, _signum: i32) {
        let _ = child.kill();
    }

    // wait for `child` by a poll of `try_wait`, `pause` milliseconds apart, calling `each` with its pid on every turn.
    // With a `limit` above 0 the child is sent TERM once `limit` milliseconds have passed and KILL 2000 ms after that.
    // The status (none when the wait failed) and whether the limit ended it
    fn wait_limited(
        child: &mut std::process::Child,
        limit: i64,
        pause: u64,
        each: &mut dyn FnMut(u32),
    ) -> (Option<std::process::ExitStatus>, bool) {
        let start = std::time::Instant::now();
        let deadline = std::time::Duration::from_millis(limit.max(0) as u64);
        let mut termed: Option<std::time::Instant> = None;
        let mut killed = false;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return (Some(status), termed.is_some()),
                Ok(None) => {
                    each(child.id());
                    if limit > 0 {
                        match termed {
                            None => {
                                if start.elapsed() >= deadline {
                                    signal_child(child, 15);
                                    termed = Some(std::time::Instant::now());
                                }
                            }
                            Some(at) => {
                                if !killed && at.elapsed() >= std::time::Duration::from_millis(2000) {
                                    signal_child(child, 9);
                                    killed = true;
                                }
                            }
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(pause));
                }
                Err(_) => return (None, termed.is_some()),
            }
        }
    }

    // a stream read to its end on a thread of its own, into a buffer the caller can read at any time
    fn reading<R: std::io::Read + Send + 'static>(
        mut from: R,
    ) -> (std::sync::Arc<std::sync::Mutex<Vec<u8>>>, std::thread::JoinHandle<()>) {
        let kept = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let into = kept.clone();
        let handle = std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match from.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if let Ok(mut held) = into.lock() {
                            held.extend_from_slice(&chunk[..count]);
                        }
                    }
                }
            }
        });
        (kept, handle)
    }

    fn read_text(kept: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>) -> String {
        match kept.lock() {
            Ok(held) => String::from_utf8_lossy(&held).to_string(),
            Err(_) => String::new(),
        }
    }

    // a captured run under a limit above 0: stdout and stderr each read on a thread, the child waited by a poll and
    // ended at the limit, and the answer taken once both readers are done or 500 ms after the exit (a grandchild may
    // hold a pipe). Code -2 when the limit ended it
    fn captured_limited(mut shaped: std::process::Command, input: Option<String>, limit: i64) -> RunResult {
        use std::io::Write;
        let spawned = shaped
            .stdin(if input.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(cause) => return refused(cause),
        };
        let (output, output_reader) = match child.stdout.take() {
            Some(stream) => reading(stream),
            None => reading(std::io::empty()),
        };
        let (error, error_reader) = match child.stderr.take() {
            Some(stream) => reading(stream),
            None => reading(std::io::empty()),
        };
        if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
            let _ = stdin.write_all(text.as_bytes());
        }
        let (status, ended) = wait_limited(&mut child, limit, 10, &mut |_| {});
        let drained = std::time::Instant::now();
        while !(output_reader.is_finished() && error_reader.is_finished())
            && drained.elapsed() < std::time::Duration::from_millis(500)
        {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let (code, signal) = match status {
            _ if ended => (-2, 0),
            Some(status) => finished(status),
            None => (-1, 0),
        };
        RunResult { code, output: read_text(&output), error: read_text(&error), signal }
    }

    // `argument_list` arrives as the seed list representation (a reference-counted mutable vec); borrow it to read the
    // arguments without taking ownership.
    pub async fn run(
        command: String,
        argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        directory: String,
        environment: Environment,
        limit: i64,
    ) -> RunResult {
        if limit > 0 {
            return captured_limited(shaped(&command, &argument_list, &directory, &environment), None, limit);
        }
        match shaped(&command, &argument_list, &directory, &environment).output() {
            Ok(out) => answered(out),
            Err(cause) => refused(cause),
        }
    }

    // The signals an attached child waits through, as system(3) handles them, with no crate: INT and QUIT ignored (the
    // terminal sends them to the whole foreground group, so the child gets each itself), TERM and HUP recorded in
    // `ARRIVED` and passed on to the child by the poll. The numbers are the same on macOS and Linux: SIGHUP 1, SIGINT 2,
    // SIGQUIT 3, SIGTERM 15. Installed AFTER the spawn, so the child, which exec has already run when `spawn` returns,
    // keeps the default dispositions (an ignored signal would survive the exec). The dispositions in force before
    // (`signal.tree`'s own handlers when its watch is on) come back when the child is gone.
    #[cfg(unix)]
    mod passing {
        use std::sync::atomic::{AtomicU32, Ordering};

        // one bit per signal number that arrived and has not been passed on
        static ARRIVED: AtomicU32 = AtomicU32::new(0);

        const IGNORED: [i32; 2] = [2, 3];
        const PASSED: [i32; 2] = [1, 15];
        // `signal` answers this for a handler it could not set
        const FAILED: usize = usize::MAX;
        const DEFAULT: usize = 0;
        const IGNORE: usize = 1;

        extern "C" {
            fn signal(signum: i32, handler: usize) -> usize;
            fn siginterrupt(signum: i32, flag: i32) -> i32;
            fn kill(pid: i32, signum: i32) -> i32;
        }

        extern "C" fn notice(signum: i32) {
            ARRIVED.fetch_or(1 << signum, Ordering::SeqCst);
        }

        // the dispositions before: a signal and the handler it had
        pub struct Held {
            before: Vec<(i32, usize)>,
        }

        pub fn hold() -> Held {
            ARRIVED.store(0, Ordering::SeqCst);
            let mut before = Vec::new();
            for signum in IGNORED {
                before.push((signum, unsafe { signal(signum, IGNORE) }));
            }
            for signum in PASSED {
                before.push((signum, unsafe { signal(signum, notice as usize) }));
            }
            Held { before }
        }

        // send the child each signal that arrived since the last call
        pub fn pass(child: u32) {
            let arrived = ARRIVED.swap(0, Ordering::SeqCst);
            for signum in PASSED {
                if arrived & (1 << signum) != 0 {
                    unsafe { kill(child as i32, signum) };
                }
            }
        }

        // put each disposition back. A handler of the program's own (`signal.tree`'s) read a blocked terminal as an
        // interrupted call, so it gets the flag back that `signal` takes off
        pub fn release(held: Held) {
            for (signum, handler) in held.before {
                if handler == FAILED {
                    continue;
                }
                unsafe {
                    signal(signum, handler);
                    if handler != DEFAULT && handler != IGNORE {
                        siginterrupt(signum, 1);
                    }
                }
            }
        }
    }

    #[cfg(not(unix))]
    mod passing {
        pub struct Held;
        pub fn hold() -> Held { Held }
        pub fn pass(_child: u32) {}
        pub fn release(_held: Held) {}
    }

    // the command on this terminal: it reads the keyboard and writes as it goes; its exit code (128 plus the signal for
    // a signal death), -1 when it could not start. While it runs, INT and QUIT are ignored here and TERM and HUP sent to
    // this process are passed to it (`passing`, as system(3) does). The wait is a poll of `try_wait` with a short sleep,
    // so a recorded signal is passed within a few milliseconds. A `limit` above 0 ends the child as `wait_limited` does,
    // and answers -2
    pub async fn attached(
        command: String,
        argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        directory: String,
        environment: Environment,
        limit: i64,
    ) -> i64 {
        let mut child = match shaped(&command, &argument_list, &directory, &environment).spawn() {
            Ok(child) => child,
            Err(_) => return -1,
        };
        let held = passing::hold();
        let (status, ended) = wait_limited(&mut child, limit, 5, &mut |pid| passing::pass(pid));
        passing::release(held);
        match status {
            _ if ended => -2,
            Some(status) => finished(status).0,
            None => -1,
        }
    }

    // the command with `input` written to its standard input and then closed, its output captured as `run` captures it
    pub async fn with_input(
        command: String,
        argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        input: String,
        directory: String,
        environment: Environment,
        limit: i64,
    ) -> RunResult {
        use std::io::Write;
        if limit > 0 {
            return captured_limited(shaped(&command, &argument_list, &directory, &environment), Some(input), limit);
        }
        let spawned = shaped(&command, &argument_list, &directory, &environment)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(cause) => return refused(cause),
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input.as_bytes());
        }
        match child.wait_with_output() {
            Ok(out) => answered(out),
            Err(cause) => refused(cause),
        }
    }
}
