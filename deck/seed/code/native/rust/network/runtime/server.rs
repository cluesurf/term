// rust HTTP server runtime: a blocking, std-only accept loop (no async runtime / external crate). It reads each request,
// parses the request line into a normalized Request, calls the seed handler, and writes the response. `serve` blocks for
// the life of the process -- the entry point of a server binary. Reached only through the public network/server API.
mod runtime {
    use super::{Request, Response};
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    type Handler = Box<dyn Fn(Request) -> Response>;

    pub fn serve(port: i64, host: String, handler: Handler) {
        let listener =
            TcpListener::bind(format!("{}:{}", host, port)).expect("server bind");

        for incoming in listener.incoming() {
            let mut stream = match incoming {
                Ok(stream) => stream,
                Err(_) => continue,
            };

            let mut buffer = [0u8; 8192];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let text = String::from_utf8_lossy(&buffer[..read]).into_owned();

            // the request line: METHOD TARGET HTTP/1.1
            let line = text.lines().next().unwrap_or("");
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or("GET").to_string();
            let target = parts.next().unwrap_or("/").to_string();
            let (path, query) = match target.split_once('?') {
                Some((path, query)) => (path.to_string(), query.to_string()),
                None => (target.clone(), String::new()),
            };

            let body = match text.split_once("\r\n\r\n") {
                Some((_, body)) => body.to_string(),
                None => String::new(),
            };

            let request = Request {
                method,
                url: target,
                path,
                query,
                headers: std::rc::Rc::new(std::cell::RefCell::new(HashMap::new())),
                body,
                dock: std::rc::Rc::new(0i64),
            };

            let response = handler(request);

            // the handler's headers, one CRLF-terminated line each, ahead of the framing headers
            let mut header_block = String::new();
            for header in response.headers.borrow().iter() {
                header_block
                    .push_str(&format!("{}: {}\r\n", header.name, header.value));
            }

            let payload = format!(
                "HTTP/1.1 {} OK\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n{}",
                response.status,
                response.body.len(),
                header_block,
                response.body
            );
            let _ = stream.write_all(payload.as_bytes());
        }
    }
}
