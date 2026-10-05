// The solver binding on Rust: SMT-LIB2 text in, Z3's answer out, through a `z3 -in` process per script. The node
// binding (smt-text.ts) keeps one Z3 context, and this keeps none, which is why smt-query.tree sends each question as
// one self-contained script, the model asked for in the same text. `TERM_Z3` names the binary, else `z3` on the path.
mod smt_text {
    // async because smt-query awaits it (`wait smt-text/evaluate(..)`, the node binding being a promise). The process
    // itself is waited on in place
    pub async fn evaluate(text: String) -> String {
        use std::io::Write;

        let binary = std::env::var("TERM_Z3").unwrap_or_else(|_| "z3".to_string());
        let mut child = match std::process::Command::new(binary)
            .arg("-in")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return "unknown".to_string(),
        };

        if let Some(mut input) = child.stdin.take() {
            let _ = input.write_all(text.as_bytes());
            let _ = input.write_all(b"\n(exit)\n");
        }

        match child.wait_with_output() {
            Ok(done) => String::from_utf8_lossy(&done.stdout).into_owned(),
            Err(_) => "unknown".to_string(),
        }
    }
}
