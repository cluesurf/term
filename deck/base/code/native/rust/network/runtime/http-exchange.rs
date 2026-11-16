// HTTP exchanges over reqwest's blocking client, held by number on the program's one thread. `open` sends the request,
// its body as bytes (none when empty), redirects followed only under `follow` (else reqwest's `Policy::none`, which
// answers the redirect as it is), and answers `ok`, the exchange's number, the status, then each response header as a
// lower-case name and its value; or `timeout` / `outage` and the host's message. The body stays unread: `read` takes
// up to `room` bytes of it, `fault` says after each read whether it broke off (and lets go of an exchange whose body
// ended), `cancel` drops it unread. The client's timeout holds over the body's reads too. The public http module
// (base/code/network/http.tree) raises from these, so every backend answers alike.
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

    pub async fn open(method: String, url: String, body: Vec<u8>, header: Header, timeout: i64, follow: bool) -> Vec<String> {
        // the headers read out on this thread: the map is the program's, and never crosses to a worker
        let pairs: Vec<(String, String)> =
            header.borrow().iter().map(|(name, value)| (name.clone(), value.clone())).collect();
        match crate::__term_hand_back(move || send(method, url, body, pairs, timeout, follow)).await {
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
                        Held { response: Some(response), done: false, fault: vec![String::new(), String::new()] },
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
        let policy = if follow { ::reqwest::redirect::Policy::default() } else { ::reqwest::redirect::Policy::none() };
        let client = ::reqwest::blocking::Client::builder()
            .timeout(::std::time::Duration::from_millis(timeout.max(0) as u64))
            .redirect(policy)
            .build()
            .map_err(|error| failed(&error))?;
        let verb = method.parse::<::reqwest::Method>().unwrap_or(::reqwest::Method::GET);
        let mut builder = client.request(verb, &url);
        for (name, value) in header.iter() {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if !body.is_empty() {
            builder = builder.body(body);
        }
        let response = builder.send().map_err(|error| failed(&error))?;
        let mut head = vec![response.status().as_u16().to_string()];
        for (name, value) in response.headers().iter() {
            head.push(name.as_str().to_lowercase());
            head.push(String::from_utf8_lossy(value.as_bytes()).to_string());
        }
        Ok((head, response))
    }

    pub async fn read(ticket: i64, room: i64) -> Vec<u8> {
        let taken = HELD.with(|held| {
            let mut table = held.borrow_mut();
            // a body already read to its end, asked again: gone, as `fault` then says
            if table.get(&ticket).is_some_and(|one| one.done) {
                table.remove(&ticket);
                return None;
            }
            table.get_mut(&ticket).map(|one| one.response.take())
        });
        let response = match taken {
            None => return Vec::new(),
            Some(None) => {
                HELD.with(|held| {
                    if let Some(one) = held.borrow_mut().get_mut(&ticket) {
                        one.done = true;
                    }
                });
                return Vec::new();
            }
            Some(Some(response)) => response,
        };
        let room = room.max(0) as u64;
        let (bytes, back, fault) = crate::__term_hand_back(move || {
            let mut response = response;
            let mut bytes = Vec::new();
            let said = std::io::Read::read_to_end(&mut std::io::Read::take(std::io::Read::by_ref(&mut response), room), &mut bytes);
            match said {
                Err(error) => (bytes, None, Some(broke(&error))),
                Ok(_) if (bytes.len() as u64) < room => (bytes, None, None),
                Ok(_) => (bytes, Some(response), None),
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
