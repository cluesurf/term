mod http {
    // The one HTTP primitive over reqwest. Answers a flat list of text: `ok`, the status, the body, then each response
    // header as a lower-case name and its value; or `timeout` / `outage` and the host's message. The public http
    // module (base/code/network/http.tree) builds the response from it, so every backend answers alike.
    //
    // The request is reqwest's blocking client HANDED BACK (`crate::__term_hand_back`, decision 001): it runs on the
    // runtime's pool and the waiting task resumes on the program's one thread, so the other jobs run while it waits.
    // The async client needs a tokio reactor, which Term's executor is not.
    pub async fn request(
        method: String,
        url: String,
        body: String,
        header: ::std::rc::Rc<::std::cell::RefCell<crate::TermMap<String, String>>>,
        timeout: i64,
    ) -> Vec<String> {
        // the headers read out on this thread: the map is the program's, and never crosses to a worker
        let pairs: Vec<(String, String)> =
            header.borrow().iter().map(|(name, value)| (name.clone(), value.clone())).collect();

        crate::__term_hand_back(move || send(method, url, body, pairs, timeout)).await
    }

    fn send(method: String, url: String, body: String, header: Vec<(String, String)>, timeout: i64) -> Vec<String> {
        let failed = |error: ::reqwest::Error| -> Vec<String> {
            vec![if error.is_timeout() { "timeout" } else { "outage" }.to_string(), error.to_string()]
        };
        let client = match ::reqwest::blocking::Client::builder()
            .timeout(::std::time::Duration::from_millis(timeout.max(0) as u64))
            .build()
        {
            Ok(client) => client,
            Err(error) => return failed(error),
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
            Err(error) => return failed(error),
        };
        let status = response.status().as_u16().to_string();
        let mut pairs: Vec<String> = Vec::new();
        for (name, value) in response.headers().iter() {
            pairs.push(name.as_str().to_lowercase());
            pairs.push(String::from_utf8_lossy(value.as_bytes()).to_string());
        }
        match response.text() {
            Ok(text) => {
                let mut out = vec!["ok".to_string(), status, text];
                out.extend(pairs);
                out
            }
            Err(error) => failed(error),
        }
    }
}
