mod http {
    // The one HTTP primitive over reqwest. Answers a flat list of text: `ok`, the status, the body, then each response
    // header as a lower-case name and its value; or `timeout` / `outage` and the host's message. The public http
    // module (base/code/network/http.tree) builds the response from it, so every backend answers alike.
    pub async fn request(
        method: String,
        url: String,
        body: String,
        header: ::std::rc::Rc<::std::cell::RefCell<crate::TermMap<String, String>>>,
        timeout: i64,
    ) -> Vec<String> {
        let failed = |error: ::reqwest::Error| -> Vec<String> {
            vec![if error.is_timeout() { "timeout" } else { "outage" }.to_string(), error.to_string()]
        };
        let client = match ::reqwest::Client::builder()
            .timeout(::std::time::Duration::from_millis(timeout.max(0) as u64))
            .build()
        {
            Ok(client) => client,
            Err(error) => return failed(error),
        };
        let verb = method.parse::<::reqwest::Method>().unwrap_or(::reqwest::Method::GET);
        let mut builder = client.request(verb, &url);
        for (name, value) in header.borrow().iter() {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if !body.is_empty() {
            builder = builder.body(body);
        }
        let response = match builder.send().await {
            Ok(response) => response,
            Err(error) => return failed(error),
        };
        let status = response.status().as_u16().to_string();
        let mut pairs: Vec<String> = Vec::new();
        for (name, value) in response.headers().iter() {
            pairs.push(name.as_str().to_lowercase());
            pairs.push(String::from_utf8_lossy(value.as_bytes()).to_string());
        }
        match response.text().await {
            Ok(text) => {
                let mut out = vec!["ok".to_string(), status, text];
                out.extend(pairs);
                out
            }
            Err(error) => failed(error),
        }
    }
}
