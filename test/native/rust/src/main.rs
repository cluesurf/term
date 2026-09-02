// The rust native smoke suite: the SHIPPED runtime shims, compiled and run against tokio and hyper.
//
// The native gate proves every module type-checks and `cargo check`s. It never runs a line. This does: it writes
// a file with `aio::file_write`, reads it back, appends, streams it, stats it, walks a directory, watches for a
// change, and serves an HTTP request through the hyper shim and fetches it. If a shim compiles but does the wrong
// thing, this is what says so.
//
// The shims are INCLUDED from the stdlib rather than copied, so this tests what ships. They are source fragments
// the compiler prepends to emitted code and they read the emitted forms out of that scope, which is why those
// forms are declared here first: this file stands in for the emitted module.
//
// Run it with `pnpm term:rust test`.
#![allow(dead_code, unused_imports)]

// ---- the forms the shims expect from the emitted program ----

#[derive(Clone, Debug)]
pub struct FileMetadata {
    pub size: i64,
    pub kind: String,
    pub made: i64,
    pub changed: i64,
    pub opened: i64,
    pub mode: i64,
    pub link: bool,
}

#[derive(Clone, Debug)]
pub struct WalkEntry {
    pub path: String,
    pub kind: String,
    pub depth: i64,
}

#[derive(Clone, Debug)]
pub struct WatchEvent {
    pub kind: String,
    pub path: String,
}

#[derive(Clone, Debug)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Clone)]
pub struct Request {
    pub method: String,
    pub url: String,
    pub path: String,
    pub query: String,
    pub headers: std::rc::Rc<
        std::cell::RefCell<std::collections::HashMap<String, String>>,
    >,
    pub body: String,
    pub dock: std::rc::Rc<()>,
}

#[derive(Clone)]
pub struct Response {
    pub status: i64,
    pub headers: std::rc::Rc<std::cell::RefCell<Vec<Header>>>,
    pub body: String,
}

// ---- the shipped shims ----

include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../deck/seed/code/native/rust/file/runtime/aio.rs"
));
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../deck/seed/code/native/rust/file/runtime/watch.rs"
));
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../deck/seed/code/native/rust/file/asynchronous/runtime/stat.rs"
));
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../deck/seed/code/native/rust/file/asynchronous/runtime/walk.rs"
));
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../deck/seed/code/native/rust/network/runtime/server.rs"
));
include!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../deck/seed/code/native/rust/network/runtime/http2.rs"
));

// ---- the harness ----

static mut FAILED: usize = 0;
static mut RAN: usize = 0;

fn check(what: &str, ok: bool) {
    unsafe {
        RAN += 1;

        if !ok {
            FAILED += 1;
        }
    }

    println!("{}  {}", if ok { "ok  " } else { "FAIL" }, what);
}

fn same<T: std::fmt::Debug + PartialEq>(what: &str, got: T, want: T) {
    let ok = got == want;
    check(
        &if ok {
            what.to_string()
        } else {
            format!("{}: got {:?}, want {:?}", what, got, want)
        },
        ok,
    );
}

async fn files() {
    let root = aio::temporary_make(
        "directory".to_string(),
        "term-suite-".to_string(),
        String::new(),
    )
    .await;
    check("temporary directory made", !root.is_empty());

    let one = format!("{}/one.txt", root);

    aio::file_write(one.clone(), "hello".to_string()).await;
    same("write then read", aio::file_read(one.clone()).await, "hello".to_string());

    aio::file_append(one.clone(), " world".to_string()).await;
    same(
        "append",
        aio::file_read(one.clone()).await,
        "hello world".to_string(),
    );

    same(
        "read bytes",
        aio::file_read_bytes(one.clone()).await,
        b"hello world".to_vec(),
    );

    check("test with no kind", aio::file_test(one.clone(), String::new()).await);
    check(
        "test file",
        aio::file_test(one.clone(), "file".to_string()).await,
    );
    check(
        "test directory is false on a file",
        !aio::file_test(one.clone(), "directory".to_string()).await,
    );
    check(
        "test on a missing path",
        !aio::file_test(format!("{}/nope", root), String::new()).await,
    );

    // metadata: one call, the whole record
    let meta = stat::meta_read(one.clone(), true).await;
    same("metadata size", meta.size, 11);
    same("metadata kind", meta.kind.clone(), "file".to_string());
    check("metadata mode is set", meta.mode != 0);
    check("metadata changed is set", meta.changed > 0);

    // copy, move, remove
    let two = format!("{}/two.txt", root);
    aio::file_copy(one.clone(), two.clone(), false).await;
    same("copy", aio::file_read(two.clone()).await, "hello world".to_string());

    let three = format!("{}/three.txt", root);
    aio::file_move(two.clone(), three.clone()).await;
    check("move took the source away", !aio::file_test(two.clone(), String::new()).await);
    same(
        "move put it at the target",
        aio::file_read(three.clone()).await,
        "hello world".to_string(),
    );

    aio::file_remove(three.clone(), false).await;
    check("remove", !aio::file_test(three.clone(), String::new()).await);

    // links
    let link = format!("{}/link.txt", root);
    aio::link_make(one.clone(), link.clone(), false).await;
    check(
        "symbolic link is a link",
        aio::file_test(link.clone(), "link".to_string()).await,
    );
    same("link read", aio::link_read(link.clone()).await, one.clone());

    // permission
    aio::permission_write(one.clone(), 0o644).await;
    same(
        "permission round trip",
        aio::permission_read(one.clone()).await & 0o777,
        0o644,
    );

    // owner: the read must answer this process's own ids
    check("owner user", aio::owner_user(one.clone()).await >= 0);
    check("owner group", aio::owner_group(one.clone()).await >= 0);

    // handle: open, seek, read, write
    let handle = aio::handle_open(one.clone(), true, true, false, false, false).await;
    same("handle read from the start", aio::handle_read(handle.clone(), 5).await, "hello".to_string());
    aio::handle_seek(handle.clone(), 6, "start".to_string()).await;
    same("handle read after seek", aio::handle_read(handle.clone(), 5).await, "world".to_string());
    aio::handle_seek(handle.clone(), 0, "start".to_string()).await;
    same("handle write", aio::handle_write(handle.clone(), "HELLO".to_string()).await, 5);
    aio::handle_flush(handle.clone()).await;
    aio::handle_close(handle.clone()).await;
    same(
        "handle write landed",
        aio::file_read(one.clone()).await,
        "HELLO world".to_string(),
    );

    // handle clear
    let handle = aio::handle_open(one.clone(), true, true, false, false, false).await;
    aio::handle_clear(handle.clone(), 5).await;
    aio::handle_close(handle).await;
    same("handle clear", aio::file_read(one.clone()).await, "HELLO".to_string());

    // streams
    let big = format!("{}/big.txt", root);
    let writer = aio::writer_open(big.clone(), false).await;
    aio::writer_push(writer.clone(), "one ".to_string()).await;
    aio::writer_push(writer.clone(), "two ".to_string()).await;
    aio::writer_push(writer.clone(), "three".to_string()).await;
    aio::writer_close(writer).await;
    same(
        "write stream",
        aio::file_read(big.clone()).await,
        "one two three".to_string(),
    );

    let reader = aio::reader_open(big.clone(), 4, 3).await;
    same("read stream window", aio::reader_next(reader.clone()).await, "two".to_string());
    same("read stream end", aio::reader_next(reader.clone()).await, String::new());
    aio::reader_close(reader).await;

    // directories
    let nest = format!("{}/a/b", root);
    walk_file::dir_make(nest.clone()).await;
    check("nested make", aio::file_test(nest.clone(), "directory".to_string()).await);
    aio::file_write(format!("{}/deep.txt", nest), "deep".to_string()).await;

    let shallow = walk_file::dir_list(root.clone(), false).await;
    check("list is one level", shallow.contains(&"a".to_string()));
    check(
        "list is one level, not more",
        !shallow.iter().any(|name| name.contains('/')),
    );

    let deep = walk_file::dir_list(root.clone(), true).await;
    check("deep list reaches down", deep.contains(&"a/b/deep.txt".to_string()));

    let entries = walk_file::dir_walk(root.clone(), 0).await;
    check(
        "walk names a directory",
        entries.iter().any(|e| e.kind == "directory"),
    );
    check(
        "walk carries depth",
        entries.iter().any(|e| e.depth > 0),
    );

    let bounded = walk_file::dir_walk(root.clone(), 1).await;
    check(
        "walk depth 1 stops at one level",
        bounded.iter().all(|e| e.depth == 0),
    );

    // deep copy and deep remove
    let copy = format!("{}-copy", root);
    aio::file_copy(root.clone(), copy.clone(), true).await;
    check(
        "deep copy reached the leaf",
        aio::file_test(format!("{}/a/b/deep.txt", copy), String::new()).await,
    );
    aio::file_remove(copy.clone(), true).await;
    check("deep remove", !aio::file_test(copy, String::new()).await);

    // watching
    let watcher = watch_file::watch_open(root.clone(), true).await;
    let watched = format!("{}/watched.txt", root);
    let seen = tokio::spawn({
        let watcher = watcher.clone();
        async move {
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                watch_file::watch_next(watcher),
            )
            .await
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    aio::file_write(watched.clone(), "changed".to_string()).await;

    match seen.await {
        Ok(Ok(event)) => check(
            &format!("watch saw a change ({})", event.kind),
            !event.kind.is_empty(),
        ),
        _ => check("watch saw a change", false),
    }

    watch_file::watch_close(watcher.clone()).await;
    let after = watch_file::watch_next(watcher).await;
    same("watch after close is the empty event", after.kind, String::new());

    aio::file_remove(root, true).await;
}

async fn server() {
    // a port the system picks, so the suite cannot collide with anything already listening
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("suite bind");
    let port = listener.local_addr().expect("suite port").port() as i64;
    drop(listener);

    let handler: runtime::Handler = std::rc::Rc::new(move |request: Request| {
        let headers = std::rc::Rc::new(std::cell::RefCell::new(vec![
            Header {
                name: "content-type".to_string(),
                value: "text/plain".to_string(),
            },
            Header {
                name: "set-cookie".to_string(),
                value: "one=1".to_string(),
            },
            Header {
                name: "set-cookie".to_string(),
                value: "two=2".to_string(),
            },
        ]));

        Response {
            status: 201,
            headers,
            body: format!(
                "{} {} q={} agent={} body={}",
                request.method,
                request.path,
                request.query,
                request
                    .headers
                    .borrow()
                    .get("x-agent")
                    .cloned()
                    .unwrap_or_default(),
                request.body,
            ),
        }
    });

    let server = runtime::start(
        port,
        "127.0.0.1".to_string(),
        handler,
        false,
        String::new(),
        String::new(),
    )
    .await;

    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // a body big enough that it cannot arrive in the first packet, which is exactly what the old hand-rolled
    // loop truncated
    let payload = "x".repeat(40000);
    let (status, headers, body) = fetch(port, &payload).await;

    same("server status", status, 201);
    check(
        "server read the whole body",
        body.ends_with(&format!("body={}", payload)),
    );
    check("server read the path", body.contains("POST /hello"));
    check("server read the query", body.contains("q=a=1&b=2"));
    check("server read a request header", body.contains("agent=suite"));
    check(
        "server sent content-type",
        headers.iter().any(|h| h == "content-type: text/plain"),
    );
    same(
        "server kept BOTH set-cookie headers",
        headers.iter().filter(|h| h.starts_with("set-cookie:")).count(),
        2,
    );

    runtime::stop(server).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    check(
        "server stopped",
        tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
            .await
            .is_err(),
    );
}

// a raw HTTP/1.1 request, so the suite tests the server rather than a client library
async fn fetch(port: i64, payload: &str) -> (i64, Vec<String>, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
        .await
        .expect("suite connect");
    let request = format!(
        "POST /hello?a=1&b=2 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Agent: suite\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload,
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("suite write");

    let mut whole = Vec::new();
    stream.read_to_end(&mut whole).await.expect("suite read");

    let text = String::from_utf8_lossy(&whole).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<i64>().ok())
        .unwrap_or(0);
    let headers = lines
        .map(|line| line.to_lowercase())
        .collect::<Vec<String>>();

    (status, headers, body.to_string())
}

// HTTP/2 cleartext, checked with curl rather than a client of our own: curl links nghttp2 and
// `--http2-prior-knowledge` speaks h2c, so this proves the server against an INDEPENDENT implementation. The
// `%{http_version}` write-out is the part that matters -- a server that quietly answered HTTP/1.1 would pass
// every other assertion here.
async fn http2_server() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("suite bind");
    let port = listener.local_addr().expect("suite port").port() as i64;
    drop(listener);

    let handler: http2::Handler = std::rc::Rc::new(move |request: Request| Response {
        status: 200,
        headers: std::rc::Rc::new(std::cell::RefCell::new(vec![Header {
            name: "content-type".to_string(),
            value: "text/plain".to_string(),
        }])),
        body: format!(
            "{} scheme={} stream={}",
            request.path,
            request
                .headers
                .borrow()
                .get(":scheme")
                .cloned()
                .unwrap_or_default(),
            request
                .headers
                .borrow()
                .get("x-term-stream")
                .cloned()
                .unwrap_or_default(),
        ),
    });

    let server = http2::start(
        port,
        "127.0.0.1".to_string(),
        handler,
        false,
        String::new(),
        String::new(),
    )
    .await;

    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let out = tokio::process::Command::new("curl")
        .args([
            "--http2-prior-knowledge",
            "--silent",
            "--max-time",
            "10",
            "--write-out",
            "|version=%{http_version}",
            &format!("http://127.0.0.1:{}/h2/path", port),
        ])
        .output()
        .await;

    match out {
        Ok(out) => {
            let said = String::from_utf8_lossy(&out.stdout).to_string();
            check(
                &format!("http2 answered over h2c ({})", said.trim()),
                said.contains("/h2/path"),
            );
            check(
                "http2 negotiated HTTP/2, not 1.1",
                said.contains("|version=2"),
            );
            check("http2 filled the :scheme pseudo-header", said.contains("scheme=http"));
        }
        Err(error) => check(&format!("http2 curl ran ({})", error), false),
    }

    http2::stop(server).await;
}

fn main() {
    // the same runtime shape `runtime::serve` builds: current thread plus a LocalSet, because a Term task value
    // is an Rc and cannot leave its thread
    let tokio = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("suite runtime");
    let local = tokio::task::LocalSet::new();

    local.block_on(&tokio, async {
        println!("-- asynchronous files (tokio::fs)");
        files().await;
        println!("-- http server (hyper)");
        server().await;
        println!("-- http2 server (hyper h2c)");
        http2_server().await;
    });

    unsafe {
        println!("\nrust native suite: {} checks, {} failed", RAN, FAILED);

        if FAILED > 0 {
            std::process::exit(1);
        }
    }
}
