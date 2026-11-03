// Child processes over std::process::Command, held by number. `start` spawns the command with all three streams piped
// and answers the child's number, `refusal` then holding why it could not start (the empty text when it started). Each
// output stream is read to its end on a thread of its own into a buffer that `line` and `rest` take from. Every wait
// here is a poll beside a timer of the program's executor (`__term_sleep`), so the other jobs run while one waits on a
// child. `limit` (milliseconds, 0 or below none) ends the child with TERM, then KILL 2000 ms later, from a thread that
// sleeps until then, and `group` makes the child lead a new process group, so the limit and `stop` signal the whole
// group. `wait` answers once the child has exited and both streams ended, or under a limit 500 ms after the exit (a
// grandchild may hold a pipe): its code, 128 plus the signal's number for a signal death, -2 when its limit ended it, -1
// when it never started. The same rules as the run runner (runner.rs, D025). Reached only through the public
// process/child API.
mod child_process {
    use std::io::{Read, Write};

    type Environment = std::rc::Rc<std::cell::RefCell<crate::TermMap<String, String>>>;
    type Shared<T> = std::sync::Arc<std::sync::Mutex<T>>;

    // what a stream has written that nobody took yet, and whether it has ended
    struct Stream {
        bytes: Vec<u8>,
        ended: bool,
    }

    // the limit's thread and the waits agree through this: whether the child is reaped (its pid then free for another
    // process, so nothing may signal it), and whether the limit fired
    struct Watch {
        reaped: bool,
        fired: bool,
    }

    struct Held {
        child: Option<std::process::Child>,
        refusal: String,
        stdin: Option<std::process::ChildStdin>,
        out: Shared<Stream>,
        err: Shared<Stream>,
        watch: Shared<Watch>,
        pid: i32,
        group: bool,
        limit: i64,
        code: i64,
        signal: i64,
        exited: Option<std::time::Instant>,
    }

    thread_local! {
        static HELD: std::cell::RefCell<std::collections::HashMap<i64, Held>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
        static NEXT: std::cell::Cell<i64> = const { std::cell::Cell::new(0) };
    }

    #[cfg(unix)]
    fn send(pid: i32, group: bool, signum: i32) {
        extern "C" {
            fn kill(pid: i32, signum: i32) -> i32;
        }
        unsafe { kill(if group { -pid } else { pid }, signum) };
    }

    #[cfg(not(unix))]
    fn send(_pid: i32, _group: bool, _signum: i32) {}

    // a signal to a child not yet reaped. The watch is held while it is sent, so the child cannot be reaped between the
    // test and the signal
    fn signal_unreaped(watch: &Shared<Watch>, pid: i32, group: bool, signum: i32) {
        if let Ok(state) = watch.lock() {
            if !state.reaped {
                send(pid, group, signum);
            }
        }
    }

    fn reading<R: Read + Send + 'static>(mut from: R, into: Shared<Stream>) {
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match from.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if let Ok(mut held) = into.lock() {
                            held.bytes.extend_from_slice(&chunk[..count]);
                        }
                    }
                }
            }
            if let Ok(mut held) = into.lock() {
                held.ended = true;
            }
        });
    }

    fn stream() -> Shared<Stream> {
        std::sync::Arc::new(std::sync::Mutex::new(Stream { bytes: Vec::new(), ended: false }))
    }

    // the exit code a status answers and its signal: a signal death is 128 plus the signal
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

    // reap the child if it has exited, noting its code and when
    fn poll(held: &mut Held) {
        if held.exited.is_some() {
            return;
        }
        if let Some(child) = held.child.as_mut() {
            if let Ok(mut state) = held.watch.lock() {
                if let Ok(Some(status)) = child.try_wait() {
                    state.reaped = true;
                    let (code, signal) = finished(status);
                    held.code = code;
                    held.signal = signal;
                    held.exited = Some(std::time::Instant::now());
                }
            }
        }
    }

    // whether the child is over: never started, or exited with both streams ended, or exited under a limit 500 ms ago
    fn over(held: &Held) -> bool {
        if held.child.is_none() {
            return true;
        }
        match held.exited {
            None => false,
            Some(at) => {
                let ended = held.out.lock().map(|s| s.ended).unwrap_or(true)
                    && held.err.lock().map(|s| s.ended).unwrap_or(true);
                ended || (held.limit > 0 && at.elapsed() >= std::time::Duration::from_millis(500))
            }
        }
    }

    // the child's stream and whether the child is over, polled first; none for a number no child has
    fn looked(handle: i64, error: bool) -> Option<(Shared<Stream>, bool)> {
        HELD.with(|all| {
            let mut all = all.borrow_mut();
            let held = all.get_mut(&handle)?;
            poll(held);
            let stream = if error { held.err.clone() } else { held.out.clone() };
            Some((stream, over(held)))
        })
    }

    pub async fn start(
        command: String,
        argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        directory: String,
        environment: Environment,
        limit: i64,
        group: bool,
    ) -> i64 {
        let handle = NEXT.with(|next| {
            next.set(next.get() + 1);
            next.get()
        });
        let mut shaped = std::process::Command::new(&command);
        shaped.args(argument_list.borrow().iter());
        if !directory.is_empty() {
            shaped.current_dir(&directory);
        }
        for (name, value) in environment.borrow().iter() {
            shaped.env(name.as_str(), value.as_str());
        }
        #[cfg(unix)]
        if group {
            use std::os::unix::process::CommandExt;
            shaped.process_group(0);
        }
        shaped
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let out = stream();
        let err = stream();
        let watch = std::sync::Arc::new(std::sync::Mutex::new(Watch { reaped: false, fired: false }));
        let mut held = Held {
            child: None,
            refusal: String::new(),
            stdin: None,
            out: out.clone(),
            err: err.clone(),
            watch: watch.clone(),
            pid: 0,
            group,
            limit,
            code: -1,
            signal: 0,
            exited: None,
        };
        match shaped.spawn() {
            Ok(mut child) => {
                held.pid = child.id() as i32;
                held.stdin = child.stdin.take();
                match child.stdout.take() {
                    Some(from) => reading(from, out),
                    None => reading(std::io::empty(), out),
                }
                match child.stderr.take() {
                    Some(from) => reading(from, err),
                    None => reading(std::io::empty(), err),
                }
                held.child = Some(child);
                if limit > 0 {
                    let pid = held.pid;
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(limit as u64));
                        if let Ok(mut state) = watch.lock() {
                            if state.reaped {
                                return;
                            }
                            state.fired = true;
                            send(pid, group, 15);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(2000));
                        signal_unreaped(&watch, pid, group, 9);
                    });
                }
            }
            Err(cause) => {
                held.refusal = cause.to_string();
            }
        }
        HELD.with(|all| all.borrow_mut().insert(handle, held));
        handle
    }

    pub fn refusal(handle: i64) -> String {
        HELD.with(|all| match all.borrow().get(&handle) {
            Some(held) => held.refusal.clone(),
            None => String::from("no such child"),
        })
    }

    // the next line with its newline, or at the end of the stream what is left (the empty text when nothing is)
    pub async fn line(handle: i64, error: bool) -> String {
        loop {
            let (stream, done) = match looked(handle, error) {
                Some(found) => found,
                None => return String::new(),
            };
            if let Ok(mut held) = stream.lock() {
                if let Some(at) = held.bytes.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = held.bytes.drain(..at + 1).collect();
                    return String::from_utf8_lossy(&line).to_string();
                }
                if held.ended || done {
                    let rest = std::mem::take(&mut held.bytes);
                    return String::from_utf8_lossy(&rest).to_string();
                }
            }
            super::__term_sleep(2).await;
        }
    }

    // everything left on the stream once it has ended (or the child is over)
    pub async fn rest(handle: i64, error: bool) -> String {
        loop {
            let (stream, done) = match looked(handle, error) {
                Some(found) => found,
                None => return String::new(),
            };
            if let Ok(mut held) = stream.lock() {
                if held.ended || done {
                    let rest = std::mem::take(&mut held.bytes);
                    return String::from_utf8_lossy(&rest).to_string();
                }
            }
            super::__term_sleep(2).await;
        }
    }

    pub async fn write(handle: i64, data: String) {
        HELD.with(|all| {
            if let Some(held) = all.borrow_mut().get_mut(&handle) {
                if let Some(stdin) = held.stdin.as_mut() {
                    let _ = stdin.write_all(data.as_bytes());
                    let _ = stdin.flush();
                }
            }
        });
    }

    pub fn close(handle: i64) {
        HELD.with(|all| {
            if let Some(held) = all.borrow_mut().get_mut(&handle) {
                held.stdin = None;
            }
        });
    }

    pub fn stop(handle: i64, hard: bool) {
        HELD.with(|all| {
            if let Some(held) = all.borrow_mut().get_mut(&handle) {
                poll(held);
                if held.child.is_some() && held.exited.is_none() {
                    signal_unreaped(&held.watch, held.pid, held.group, if hard { 9 } else { 15 });
                }
            }
        });
    }

    pub async fn wait(handle: i64) -> i64 {
        loop {
            let answer = HELD.with(|all| {
                let mut all = all.borrow_mut();
                let held = match all.get_mut(&handle) {
                    Some(held) => held,
                    None => return Some(-1),
                };
                if held.child.is_none() {
                    return Some(-1);
                }
                poll(held);
                if !over(held) {
                    return None;
                }
                held.stdin = None;
                let fired = held.watch.lock().map(|state| state.fired).unwrap_or(false);
                Some(if fired { -2 } else { held.code })
            });
            if let Some(code) = answer {
                return code;
            }
            super::__term_sleep(5).await;
        }
    }

    pub fn signal(handle: i64) -> i64 {
        HELD.with(|all| match all.borrow().get(&handle) {
            Some(held) => {
                let fired = held.watch.lock().map(|state| state.fired).unwrap_or(false);
                if fired { 0 } else { held.signal }
            }
            None => 0,
        })
    }
}
