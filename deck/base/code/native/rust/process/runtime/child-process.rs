// Child processes over std::process::Command, held by number. `start` spawns the command with all three streams piped,
// or with `attached` all three passed through to this process's own (nothing to read, so both streams have ended at
// once), and answers the child's number, `refusal` then holding why it could not start (the empty text when it
// started). Each output stream is read to its end on a thread of its own into a buffer that `line`, `any_line` and
// `rest` take from, and every line a reader completes takes the next number of the child's count, its mark, so
// `any_line` answers the lines of both streams in the order they arrived. A last line with no newline arrives when its
// stream ends. Every wait here is a poll beside a timer of the program's executor (`__term_sleep`), so the other jobs
// run while one waits on a child. `limit` (milliseconds, 0 or below none) ends the child with TERM, then KILL 2000 ms
// later, from a thread that sleeps until then, and `group` makes the child lead a new session and process group
// (setsid, as node's `detached`), so the limit and `stop` signal the whole group. A group child not yet reaped is sent
// KILL, its whole group, from an atexit(3) hook, which runs at the end of the program, at `exit`
// (std::process::exit), and at a raise nothing caught (which exits through std::process::exit too). `wait` answers once
// the child has exited and both streams ended, or under a limit 500 ms after the exit (a grandchild may hold a pipe):
// its code, 128 plus the signal's number for a signal death, -2 when its limit ended it, -1 when it never started. The
// same rules as the run runner (runner.rs, D025). Reached only through the public process/child API.
mod child_process {
    use std::io::{Read, Write};

    type Environment = std::rc::Rc<std::cell::RefCell<crate::TermMap<String, String>>>;
    type Shared<T> = std::sync::Arc<std::sync::Mutex<T>>;

    // what a stream has written that nobody took yet, the mark of each line in it (one per newline, and one more for a
    // last line with no newline once the stream ended), and whether it has ended
    struct Stream {
        bytes: Vec<u8>,
        marks: std::collections::VecDeque<u64>,
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

    // the pids of the group children not yet reaped, each the id of its group, taken down when this process exits
    static GROUPS: std::sync::Mutex<Vec<i32>> = std::sync::Mutex::new(Vec::new());
    static HOOKED: std::sync::Once = std::sync::Once::new();

    #[cfg(unix)]
    fn send(pid: i32, group: bool, signum: i32) {
        extern "C" {
            fn kill(pid: i32, signum: i32) -> i32;
        }
        unsafe { kill(if group { -pid } else { pid }, signum) };
    }

    #[cfg(not(unix))]
    fn send(_pid: i32, _group: bool, _signum: i32) {}

    // the atexit hook: KILL to every group still held. A lock some other thread holds while the process exits is
    // never waited on
    extern "C" fn stop_groups() {
        if let Ok(groups) = GROUPS.try_lock() {
            for pid in groups.iter() {
                send(*pid, true, 9);
            }
        }
    }

    // hold a group child's pid for the exit hook, installing the hook the first time
    fn guard(pid: i32) {
        #[cfg(unix)]
        HOOKED.call_once(|| {
            extern "C" {
                fn atexit(hook: extern "C" fn()) -> i32;
            }
            unsafe { atexit(stop_groups) };
        });
        if let Ok(mut groups) = GROUPS.lock() {
            groups.push(pid);
        }
    }

    fn unguard(pid: i32) {
        if let Ok(mut groups) = GROUPS.lock() {
            groups.retain(|held| *held != pid);
        }
    }

    // a signal to a child not yet reaped. The watch is held while it is sent, so the child cannot be reaped between the
    // test and the signal
    fn signal_unreaped(watch: &Shared<Watch>, pid: i32, group: bool, signum: i32) {
        if let Ok(state) = watch.lock() {
            if !state.reaped {
                send(pid, group, signum);
            }
        }
    }

    // read a stream to its end, marking each line it completes from the child's count
    fn reading<R: Read + Send + 'static>(mut from: R, into: Shared<Stream>, count: std::sync::Arc<std::sync::atomic::AtomicU64>) {
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match from.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(size) => {
                        if let Ok(mut held) = into.lock() {
                            held.bytes.extend_from_slice(&chunk[..size]);
                            for byte in &chunk[..size] {
                                if *byte == b'\n' {
                                    let mark = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                                    held.marks.push_back(mark);
                                }
                            }
                        }
                    }
                }
            }
            if let Ok(mut held) = into.lock() {
                if matches!(held.bytes.last(), Some(byte) if *byte != b'\n') {
                    let mark = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    held.marks.push_back(mark);
                }
                held.ended = true;
            }
        });
    }

    fn stream() -> Shared<Stream> {
        std::sync::Arc::new(std::sync::Mutex::new(Stream { bytes: Vec::new(), marks: std::collections::VecDeque::new(), ended: false }))
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
                    if held.group {
                        unguard(held.pid);
                    }
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

    // both of the child's streams and whether the child is over, polled first; none for a number no child has
    fn looked(handle: i64) -> Option<(Shared<Stream>, Shared<Stream>, bool)> {
        HELD.with(|all| {
            let mut all = all.borrow_mut();
            let held = all.get_mut(&handle)?;
            poll(held);
            Some((held.out.clone(), held.err.clone(), over(held)))
        })
    }

    // the stream's next line with its newline, or once it has ended (or the child is over) what is left, the empty text
    // when nothing is. None while neither is there yet
    fn take_line(held: &mut Stream, done: bool) -> Option<String> {
        if let Some(at) = held.bytes.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = held.bytes.drain(..at + 1).collect();
            held.marks.pop_front();
            return Some(String::from_utf8_lossy(&line).to_string());
        }
        if held.ended || done {
            let rest = std::mem::take(&mut held.bytes);
            held.marks.clear();
            return Some(String::from_utf8_lossy(&rest).to_string());
        }
        None
    }

    pub async fn start(
        command: String,
        argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        directory: String,
        environment: Environment,
        limit: i64,
        group: bool,
        attached: bool,
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
            extern "C" {
                fn setsid() -> i32;
            }
            // setsid(2) is async-signal-safe, the one thing a hook between fork and exec may call
            unsafe {
                shaped.pre_exec(|| {
                    if setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        if attached {
            shaped
                .stdin(std::process::Stdio::inherit())
                .stdout(std::process::Stdio::inherit())
                .stderr(std::process::Stdio::inherit());
        } else {
            shaped
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
        }
        let out = stream();
        let err = stream();
        let count = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
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
                if group {
                    guard(held.pid);
                }
                held.stdin = child.stdin.take();
                match child.stdout.take() {
                    Some(from) => reading(from, out, count.clone()),
                    None => reading(std::io::empty(), out, count.clone()),
                }
                match child.stderr.take() {
                    Some(from) => reading(from, err, count),
                    None => reading(std::io::empty(), err, count),
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
            let (out, err, done) = match looked(handle) {
                Some(found) => found,
                None => return String::new(),
            };
            let stream = if error { err } else { out };
            if let Ok(mut held) = stream.lock() {
                if let Some(line) = take_line(&mut held, done) {
                    return line;
                }
            }
            super::__term_sleep(2).await;
        }
    }

    // the next line of either stream, the one whose mark came first, after its stream's letter (`o` or `e`). Once both
    // have ended (or the child is over) and neither holds a line, what is left of the output, then of the error stream,
    // and at last the empty text
    pub async fn any_line(handle: i64) -> String {
        loop {
            let (out, err, done) = match looked(handle) {
                Some(found) => found,
                None => return String::new(),
            };
            if let (Ok(mut out), Ok(mut err)) = (out.lock(), err.lock()) {
                let first = match (out.marks.front(), err.marks.front()) {
                    (None, None) => None,
                    (Some(_), None) => Some(false),
                    (None, Some(_)) => Some(true),
                    (Some(o), Some(e)) => Some(e < o),
                };
                if let Some(error) = first {
                    let (letter, held) = if error { ("e", &mut *err) } else { ("o", &mut *out) };
                    let line = take_line(held, done).unwrap_or_default();
                    return format!("{}{}", letter, line);
                }
                if (out.ended || done) && (err.ended || done) {
                    for (letter, held) in [("o", &mut *out), ("e", &mut *err)] {
                        if !held.bytes.is_empty() {
                            let rest = std::mem::take(&mut held.bytes);
                            held.marks.clear();
                            return format!("{}{}", letter, String::from_utf8_lossy(&rest));
                        }
                    }
                    return String::new();
                }
            }
            super::__term_sleep(2).await;
        }
    }

    // everything left on the stream once it has ended (or the child is over)
    pub async fn rest(handle: i64, error: bool) -> String {
        loop {
            let (out, err, done) = match looked(handle) {
                Some(found) => found,
                None => return String::new(),
            };
            let stream = if error { err } else { out };
            if let Ok(mut held) = stream.lock() {
                if held.ended || done {
                    let rest = std::mem::take(&mut held.bytes);
                    held.marks.clear();
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
