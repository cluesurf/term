// HTTP over reqwest's blocking client: whole requests, and exchanges held by number on the program's one thread.
// `request` sends a text body and answers `ok`, the status, the body as text, then each response header as a
// lower-case name and its value. `open` sends the request, its body as bytes (none when empty), redirects followed
// only under `follow` (else reqwest's `Policy::none`, which answers the redirect as it is), and answers `ok`, the
// exchange's number, the status, then each response header the same way. Either answers `timeout` / `outage` and the
// host's message instead. An exchange's body stays unread: `read` takes up to `room` bytes of it, `fault` says after
// each read whether it broke off (and lets go of an exchange whose body ended), `cancel` drops it unread. The public
// http module (base/code/network/http.tree) raises from these, so every backend answers alike.
//
// The timeout is one deadline over the whole answer, from the call to the body's last byte, as on node (decision 179
// rule 7, item term-self-host-001-1585). reqwest's blocking `timeout` bounds each connect, read and write on its own,
// so a body that trickles in under it never ends: it is kept at the same milliseconds (it then never ends a request
// the deadline would not), and the send and each read run on a thread of their own, waited only for what is left of
// the deadline set at the call. Past it the answer is `timeout`, and the thread is left to end by itself, its answer
// dropped (reqwest's own limit ends it at the latest).
//
// The send and each read are HANDED BACK (`crate::__term_hand_back`, decision 001), as runtime/http.rs's request is:
// they run on the runtime's pool and the waiting task resumes on the program's thread, so other jobs run meanwhile. A
// read takes the response out of the table, moves it to the pool and back, and puts it back when the body goes on.
#[allow(dead_code)]
mod http_exchange {
    type Header = ::std::rc::Rc<::std::cell::RefCell<crate::TermMap<String, String>>>;

    struct Held {
        response: Option<::reqwest::blocking::Response>,
        done: bool,
        fault: Vec<String>,
        deadline: ::std::time::Instant,
        timeout: i64,
    }

    thread_local! {
        static HELD: std::cell::RefCell<std::collections::HashMap<i64, Held>> =
            std::cell::RefCell::new(std::collections::HashMap::new());
        static NEXT: std::cell::Cell<i64> = const { std::cell::Cell::new(0) };
    }

    fn failed(error: &::reqwest::Error) -> Vec<String> {
        vec![if error.is_timeout() { "timeout" } else { "outage" }.to_string(), error.to_string()]
    }

    // a read that broke off: reqwest's own timeout comes wrapped in the io error
    fn broke(error: &std::io::Error) -> Vec<String> {
        let timed = error.kind() == std::io::ErrorKind::TimedOut
            || error.get_ref().and_then(|inner| inner.downcast_ref::<::reqwest::Error>()).is_some_and(|inner| inner.is_timeout());
        vec![if timed { "timeout" } else { "outage" }.to_string(), error.to_string()]
    }

    fn late(timeout: i64) -> Vec<String> {
        vec!["timeout".to_string(), format!("timed out after {} ms", timeout.max(0))]
    }

    // the deadline of a call made now with `timeout`
    fn deadline_of(timeout: i64) -> ::std::time::Instant {
        ::std::time::Instant::now() + ::std::time::Duration::from_millis(timeout.max(0) as u64)
    }

    // `work` on a thread of its own, waited until `deadline` at the most: `Err(true)` when the deadline came first (or
    // had passed already), `Err(false)` when the thread died without an answer
    fn within<T: Send + 'static>(
        deadline: ::std::time::Instant,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, bool> {
        let left = deadline.saturating_duration_since(::std::time::Instant::now());
        if left.is_zero() {
            return Err(true);
        }
        let (answer, answered) = ::std::sync::mpsc::channel();
        ::std::thread::spawn(move || {
            let _ = answer.send(work());
        });
        match answered.recv_timeout(left) {
            Ok(value) => Ok(value),
            Err(::std::sync::mpsc::RecvTimeoutError::Timeout) => Err(true),
            Err(::std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(false),
        }
    }

    fn client(timeout: i64, follow: bool) -> Result<::reqwest::blocking::Client, Vec<String>> {
        let policy = if follow { ::reqwest::redirect::Policy::default() } else { ::reqwest::redirect::Policy::none() };
        ::reqwest::blocking::Client::builder()
            .timeout(::std::time::Duration::from_millis(timeout.max(0) as u64))
            .redirect(policy)
            .build()
            .map_err(|error| failed(&error))
    }

    fn head_of(response: &::reqwest::blocking::Response) -> Vec<String> {
        let mut head = vec![response.status().as_u16().to_string()];
        for (name, value) in response.headers().iter() {
            head.push(name.as_str().to_lowercase());
            head.push(String::from_utf8_lossy(value.as_bytes()).to_string());
        }
        head
    }

    pub async fn request(method: String, url: String, body: String, header: Header, timeout: i64) -> Vec<String> {
        let deadline = deadline_of(timeout);
        // the headers read out on this thread: the map is the program's, and never crosses to a worker
        let pairs: Vec<(String, String)> =
            header.borrow().iter().map(|(name, value)| (name.clone(), value.clone())).collect();
        crate::__term_hand_back(move || {
            match within(deadline, move || ask(method, url, body, pairs, timeout)) {
                Ok(out) => out,
                Err(true) => late(timeout),
                Err(false) => vec!["outage".to_string(), "the request's thread ended without an answer".to_string()],
            }
        })
        .await
    }

    // the whole answer to a text request, its body read as text, as runtime/http.rs answered it (the redirects
    // reqwest's default policy follows)
    fn ask(method: String, url: String, body: String, header: Vec<(String, String)>, timeout: i64) -> Vec<String> {
        let client = match ::reqwest::blocking::Client::builder()
            .timeout(::std::time::Duration::from_millis(timeout.max(0) as u64))
            .build()
        {
            Ok(client) => client,
            Err(error) => return failed(&error),
        };
        let verb = method.parse::<::reqwest::Method>().unwrap_or(::reqwest::Method::GET);
        let mut builder = client.request(verb, &url);
        for (name, value) in header.iter() {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if !body.is_empty() {
            builder = builder.body(body);
        }
        let response = match builder.send() {
            Ok(response) => response,
            Err(error) => return failed(&error),
        };
        let head = head_of(&response);
        match response.text() {
            Ok(text) => {
                let mut out = vec!["ok".to_string(), head[0].clone(), text];
                out.extend(head.into_iter().skip(1));
                out
            }
            Err(error) => failed(&error),
        }
    }

    pub async fn open(method: String, url: String, body: Vec<u8>, header: Header, timeout: i64, follow: bool) -> Vec<String> {
        let deadline = deadline_of(timeout);
        // the headers read out on this thread: the map is the program's, and never crosses to a worker
        let pairs: Vec<(String, String)> =
            header.borrow().iter().map(|(name, value)| (name.clone(), value.clone())).collect();
        let sent = crate::__term_hand_back(move || {
            match within(deadline, move || send(method, url, body, pairs, timeout, follow)) {
                Ok(said) => said,
                Err(true) => Err(late(timeout)),
                Err(false) => Err(vec!["outage".to_string(), "the request's thread ended without an answer".to_string()]),
            }
        })
        .await;
        match sent {
            Err(out) => out,
            Ok((head, response)) => {
                let ticket = NEXT.with(|next| {
                    let ticket = next.get() + 1;
                    next.set(ticket);
                    ticket
                });
                HELD.with(|held| {
                    held.borrow_mut().insert(
                        ticket,
                        Held {
                            response: Some(response),
                            done: false,
                            fault: vec![String::new(), String::new()],
                            deadline,
                            timeout,
                        },
                    )
                });
                let mut out = vec!["ok".to_string(), ticket.to_string()];
                out.extend(head);
                out
            }
        }
    }

    fn send(
        method: String,
        url: String,
        body: Vec<u8>,
        header: Vec<(String, String)>,
        timeout: i64,
        follow: bool,
    ) -> Result<(Vec<String>, ::reqwest::blocking::Response), Vec<String>> {
        let client = client(timeout, follow)?;
        let verb = method.parse::<::reqwest::Method>().unwrap_or(::reqwest::Method::GET);
        let mut builder = client.request(verb, &url);
        for (name, value) in header.iter() {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if !body.is_empty() {
            builder = builder.body(body);
        }
        let response = builder.send().map_err(|error| failed(&error))?;
        Ok((head_of(&response), response))
    }

    pub async fn read(ticket: i64, room: i64) -> Vec<u8> {
        let taken = HELD.with(|held| {
            let mut table = held.borrow_mut();
            // a body already read to its end, asked again: gone, as `fault` then says
            if table.get(&ticket).is_some_and(|one| one.done) {
                table.remove(&ticket);
                return None;
            }
            table.get_mut(&ticket).map(|one| (one.response.take(), one.deadline, one.timeout))
        });
        let (response, deadline, timeout) = match taken {
            None => return Vec::new(),
            Some((None, _, _)) => {
                HELD.with(|held| {
                    if let Some(one) = held.borrow_mut().get_mut(&ticket) {
                        one.done = true;
                    }
                });
                return Vec::new();
            }
            Some((Some(response), deadline, timeout)) => (response, deadline, timeout),
        };
        let room = room.max(0) as u64;
        let (bytes, back, fault) = crate::__term_hand_back(move || {
            let reading = within(deadline, move || {
                let mut response = response;
                let mut bytes = Vec::new();
                let said =
                    std::io::Read::read_to_end(&mut std::io::Read::take(std::io::Read::by_ref(&mut response), room), &mut bytes);
                match said {
                    Err(error) => (bytes, None, Some(broke(&error))),
                    Ok(_) if (bytes.len() as u64) < room => (bytes, None, None),
                    Ok(_) => (bytes, Some(response), None),
                }
            });
            match reading {
                Ok(read) => read,
                // past the deadline: the body is let go, what was read of it with it
                Err(true) => (Vec::new(), None, Some(late(timeout))),
                Err(false) => (Vec::new(), None, Some(vec!["outage".to_string(), "the read's thread ended without an answer".to_string()])),
            }
        })
        .await;
        HELD.with(|held| {
            // let go meanwhile by `cancel`: nothing is put back
            if let Some(one) = held.borrow_mut().get_mut(&ticket) {
                one.done = back.is_none();
                one.response = back;
                if let Some(fault) = fault {
                    one.fault = fault;
                }
            }
        });
        bytes
    }

    pub fn fault(ticket: i64) -> Vec<String> {
        HELD.with(|held| {
            let mut table = held.borrow_mut();
            let (out, done) = match table.get(&ticket) {
                None => return vec!["gone".to_string(), format!("no exchange {} is held", ticket)],
                Some(one) => (one.fault.clone(), one.done),
            };
            if done {
                table.remove(&ticket);
            }
            out
        })
    }

    pub fn cancel(ticket: i64) {
        let gone = HELD.with(|held| held.borrow_mut().remove(&ticket));
        drop(gone);
    }
}
