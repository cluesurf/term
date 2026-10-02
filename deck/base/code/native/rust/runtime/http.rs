mod http {
    use super::HttpResponse;
    // `header` is a map of name to value and may be empty. A Term map is a shared handle on rust
    // (`Rc<RefCell<HashMap>>`, see the compiler's rustType), so that is what arrives here. Not exercised by the
    // round-trip harness yet: an optional parameter with no fallback (`need false`) gets no default on rust, so
    // `get(url)` does not compile there. See note/term/host/08-implementation.md.
    pub async fn request(method: String, url: String, body: String, header: ::std::rc::Rc<::std::cell::RefCell<::std::collections::HashMap<String, String>>>) -> HttpResponse {
        let client = ::reqwest::Client::new();
        let verb = method.parse::<::reqwest::Method>().unwrap_or(::reqwest::Method::GET);
        let mut builder = client.request(verb, &url);
        for (name, value) in header.borrow().iter() { builder = builder.header(name.as_str(), value.as_str()); }
        if !body.is_empty() { builder = builder.body(body); }
        match builder.send().await {
            Ok(response) => {
                let status = response.status().as_u16() as i64;
                let text = response.text().await.unwrap_or_default();
                HttpResponse { status, body: text }
            }
            Err(_) => HttpResponse { status: 0, body: String::new() },
        }
    }
}
