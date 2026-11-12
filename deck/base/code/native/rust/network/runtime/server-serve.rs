// The rust HTTP server's `serve`, blocking for the life of the process (item term-self-host-001-1218). A shim of its
// own, beside server.rs, because that one names the program's executor (`__term_spawn`, `__term_hand_back`), which
// a program with no async task does not have, and a server binary whose entry only serves is one. The server thread
// is server-thread.rs, included here as in server.rs; the design is in server.rs's header.
mod serving {
    // runtime-include: server-thread.rs

    // Run the server and block for the life of the process: the entry point of a server binary. The requests are
    // answered here, on this thread, one after another as they come
    pub fn serve(
        port: i64,
        host: String,
        handler: Handler,
        secure: bool,
        certificate: String,
        key: String,
    ) {
        let bound = match launch(port, host, secure, certificate, key) {
            Ok(bound) => bound,
            Err(error) => {
                eprintln!("{}", error);

                return;
            }
        };
        let _keep = bound.halt;

        while let Ok(asked) = bound.asked.recv() {
            answer(&handler, asked);
        }
    }

}
