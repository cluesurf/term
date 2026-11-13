// Line reading for the rust target, over standard input read by the program's own loop. The reader is held rather
// than rebuilt per call, because it keeps whatever it read past the newline: build a new one each time and the second
// line is the one the first read already swallowed.
//
// A wait for a line holds no pool worker (item 1153), as on node, whose readline over a terminal or a pipe is not on
// libuv's pool. Standard input is asked with poll(2) whether a read would wait, and only read once it would not, so
// its descriptor is never set non-blocking: that flag lives on the open file the shell shares with the program, and
// would be left on the shell's terminal. A read that would wait answers pending and notes a wake time in the loop's
// `__TERM_WAKE`, as a timer does, so `__term_block_on` sleeps until then and asks again: soon at first, backing off to
// 8 ms while nothing is typed. tokio's asynchronous stdin ran its read on tokio's blocking pool, which a program built
// as `term make --build` builds does not have (Term's loop has no tokio runtime), so the first line read panicked.
// Without poll(2) (windows), and where poll(2) cannot report the end (a FIFO or pipe, a device that is not a
// terminal: `handed_back`), the blocking read is HANDED BACK
// (note/project/term/decision/001-native-work-hands-back-to-the-loop.md).
//
// Reached only through the public process/line API.
mod prompt {
    use std::cell::RefCell;
    use std::rc::Rc;

    // what was read past the last line answered, whether standard input has ended, and whether its reads are handed
    // back rather than asked of poll(2)
    #[allow(dead_code)]
    pub struct Input {
        bytes: Vec<u8>,
        ended: bool,
        handed: bool,
    }

    pub type Tool = Rc<RefCell<Input>>;

    pub async fn line_open() -> Tool {
        Rc::new(RefCell::new(Input {
            bytes: Vec::new(),
            ended: false,
            handed: handed_back(),
        }))
    }

    // standard input whose end poll(2) cannot report: a FIFO (on macOS poll answers 0 for ever once its writer has
    // closed, trap T-1163, and fstat calls a pipe a FIFO too) or a character device that is not a terminal (poll
    // answers POLLNVAL for /dev/null and other devices). Its reads are HANDED BACK to the pool as one blocking read
    // each (note/project/term/decision/001-native-work-hands-back-to-the-loop.md), which sees the end. One worker held
    // for standard input is accepted (lead, 2026-11-10: stdin is one stream, unlike sockets) until the loop's own
    // readiness wait (item 1160) replaces it. A terminal and a regular file are asked of poll(2) as before
    #[cfg(unix)]
    fn handed_back() -> bool {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(0, &mut stat) } != 0 {
            return false;
        }
        let kind = stat.st_mode & libc::S_IFMT;
        kind == libc::S_IFIFO || (kind == libc::S_IFCHR && unsafe { libc::isatty(0) } == 0)
    }

    #[cfg(not(unix))]
    fn handed_back() -> bool {
        true
    }

    pub async fn line_ask(tool: Tool, prompt: String) -> String {
        use std::io::Write;

        let mut out = std::io::stdout();
        let _ = out.write_all(prompt.as_bytes());
        let _ = out.flush();

        line_read(tool).await
    }

    // a line as the public API gives it: without its newline, or "" for bytes that are not UTF-8
    fn text_of(line: Vec<u8>) -> String {
        match String::from_utf8(line) {
            Ok(text) => text.trim_end_matches('\n').trim_end_matches('\r').to_string(),
            Err(_) => String::new(),
        }
    }

    // the longest a quiet standard input waits between two asks, in microseconds
    #[cfg(unix)]
    const QUIET_MOST: u64 = 8000;

    // one read of standard input, retried each time the loop polls it until it no longer would wait
    #[cfg(unix)]
    struct Arrival<'a> {
        chunk: &'a mut [u8],
        tries: u32,
    }

    #[cfg(unix)]
    impl std::future::Future for Arrival<'_> {
        type Output = std::io::Result<usize>;
        fn poll(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<usize>> {
            let this = self.get_mut();
            loop {
                let mut asked = libc::pollfd {
                    fd: 0,
                    events: libc::POLLIN,
                    revents: 0,
                };
                // any answer at all (data, the end, a hang-up, a closed descriptor) means a read does not wait
                let ready = unsafe { libc::poll(&mut asked, 1, 0) };
                if ready == 0 {
                    // the first ask again on the next round, then 50 us doubling up to QUIET_MOST
                    let quiet = if this.tries == 0 {
                        0
                    } else {
                        (50u64 << (this.tries - 1).min(16)).min(QUIET_MOST)
                    };
                    this.tries = this.tries.saturating_add(1);
                    let at = std::time::Instant::now() + std::time::Duration::from_micros(quiet);
                    crate::__TERM_WAKE.with(|wake| {
                        wake.set(Some(wake.get().map_or(at, |soonest| soonest.min(at))))
                    });
                    cx.waker().wake_by_ref();
                    return std::task::Poll::Pending;
                }
                if ready < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    crate::__term_progressed();
                    return std::task::Poll::Ready(Err(error));
                }
                let count = unsafe {
                    libc::read(0, this.chunk.as_mut_ptr() as *mut libc::c_void, this.chunk.len())
                };
                if count < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    crate::__term_progressed();
                    return std::task::Poll::Ready(Err(error));
                }
                crate::__term_progressed();
                return std::task::Poll::Ready(Ok(count as usize));
            }
        }
    }

    // the line without its newline, or "" at the end of input. A last line with no newline is answered as a line,
    // and the read after it is ""
    #[cfg(unix)]
    pub async fn line_read(tool: Tool) -> String {
        let mut chunk = vec![0u8; 8192];
        loop {
            let handed = {
                let mut input = tool.borrow_mut();
                if let Some(at) = input.bytes.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = input.bytes.drain(..=at).collect();
                    return text_of(line);
                }
                if input.ended {
                    return text_of(std::mem::take(&mut input.bytes));
                }
                input.handed
            };
            let arrived: std::io::Result<Vec<u8>> = if handed {
                crate::__term_hand_back(|| {
                    let mut chunk = vec![0u8; 8192];
                    loop {
                        let count = unsafe {
                            libc::read(0, chunk.as_mut_ptr() as *mut libc::c_void, chunk.len())
                        };
                        if count >= 0 {
                            chunk.truncate(count as usize);
                            return Ok(chunk);
                        }
                        let error = std::io::Error::last_os_error();
                        if error.kind() != std::io::ErrorKind::Interrupted {
                            return Err(error);
                        }
                    }
                })
                .await
            } else {
                Arrival {
                    chunk: &mut chunk,
                    tries: 0,
                }
                .await
                .map(|count| chunk[..count].to_vec())
            };
            let mut input = tool.borrow_mut();
            match arrived {
                Ok(bytes) if bytes.is_empty() => input.ended = true,
                Err(_) => input.ended = true,
                Ok(bytes) => input.bytes.extend_from_slice(&bytes),
            }
        }
    }

    // no poll(2): the blocking read on the runtime's pool. std's standard input is one buffered reader for the
    // whole process, so nothing is lost between two calls
    #[cfg(not(unix))]
    pub async fn line_read(_tool: Tool) -> String {
        crate::__term_hand_back(|| {
            let mut line = String::new();
            match std::io::stdin().read_line(&mut line) {
                Ok(0) | Err(_) => String::new(),
                Ok(_) => line.trim_end_matches('\n').trim_end_matches('\r').to_string(),
            }
        })
        .await
    }

    // standard input is not ours to close: the tool is dropped, the descriptor stays as the process found it
    pub async fn line_close(_tool: Tool) {}
}
