mod http {
    use super::HttpResponse;
    pub async fn request(method: String, url: String, body: String) -> HttpResponse {
        let client = ::reqwest::Client::new();
        let verb = method.parse::<::reqwest::Method>().unwrap_or(::reqwest::Method::GET);
        let mut builder = client.request(verb, &url);
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
