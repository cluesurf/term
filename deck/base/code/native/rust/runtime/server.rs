// HTTP server runtime: a blocking std::net accept loop, no async runtime. Each connection reads one
// HTTP/1.1 request (request line, headers, a Content-Length body), hands the normalized `Request` record to
// the seed handler, and writes the handler's `Response` back with Connection: close. The `Request` and
// `Response` forms come from the emitted program this shim is prepended to (`use super::*`).
mod runtime {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};

    pub fn serve(
        port: i64,
        host: String,
        handler: std::rc::Rc<dyn Fn(Request) -> Response>,
    ) {
        let listener =
            std::net::TcpListener::bind((host.as_str(), port as u16))
                .expect("server: bind failed");

        for stream in listener.incoming() {
            let stream = match stream {
                Ok(s) => s,
                Err(_) => continue,
            };

            handle(stream, handler.clone());
        }
    }

    fn handle(
        stream: std::net::TcpStream,
        handler: std::rc::Rc<dyn Fn(Request) -> Response>,
    ) {
        let mut reader = BufReader::new(match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        });
        let mut line = String::new();

        if reader.read_line(&mut line).is_err() {
            return;
        }

        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("GET").to_string();
        let url = parts.next().unwrap_or("/").to_string();
        let (path, query) = match url.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (url.clone(), String::new()),
        };

        let headers: std::rc::Rc<
            std::cell::RefCell<std::collections::HashMap<String, String>>,
        > = std::rc::Rc::new(std::cell::RefCell::new(
            std::collections::HashMap::new(),
        ));
        let mut length = 0usize;

        loop {
            let mut header = String::new();

            if reader.read_line(&mut header).is_err() {
                return;
            }

            let trimmed = header.trim_end();

            if trimmed.is_empty() {
                break;
            }

            if let Some((name, value)) = trimmed.split_once(':') {
                let name = name.trim().to_lowercase();
                let value = value.trim().to_string();

                if name == "content-length" {
                    length = value.parse().unwrap_or(0);
                }

                headers.borrow_mut().insert(name, value);
            }
        }

        let mut body = vec![0u8; length];

        if length > 0 && reader.read_exact(&mut body).is_err() {
            return;
        }

        let request = Request {
            method,
            url,
            path,
            query,
            headers,
            body: String::from_utf8_lossy(&body).to_string(),
            dock: std::rc::Rc::new(()),
        };
        let response = handler(request);
        let mut out = stream;
        let mut text = format!(
            "HTTP/1.1 {} \r\nConnection: close\r\n",
            response.status,
        );

        for header in response.headers.borrow().iter() {
            text.push_str(&format!("{}: {}\r\n", header.name, header.value));
        }

        text.push_str(&format!(
            "Content-Length: {}\r\n\r\n{}",
            response.body.len(),
            response.body,
        ));
        let _ = out.write_all(text.as_bytes());
    }
}
