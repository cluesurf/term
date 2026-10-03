// Subprocess runner over std::process::Command. Runs the command to completion, capturing stdout and stderr, and
// returns the exit code with both streams. A spawn failure returns code -1 and the error text, so the public run API
// stays total. Reached only through the public run API.
mod runner {
    use super::RunResult;
    // `argument_list` arrives as the seed list representation (a reference-counted mutable vec); borrow it to read the
    // arguments without taking ownership.
    pub async fn run(command: String, argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>) -> RunResult {
        let arguments = argument_list.borrow();
        match std::process::Command::new(&command).args(arguments.iter()).output() {
            Ok(out) => RunResult {
                code: out.status.code().unwrap_or(0) as i64,
                output: String::from_utf8_lossy(&out.stdout).to_string(),
                error: String::from_utf8_lossy(&out.stderr).to_string(),
            },
            Err(cause) => RunResult {
                code: -1,
                output: String::new(),
                error: cause.to_string(),
            },
        }
    }

    // the command on this terminal: it reads the keyboard and writes as it goes; its exit code, -1 when it could not start
    pub async fn attached(command: String, argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>) -> i64 {
        let arguments = argument_list.borrow();
        match std::process::Command::new(&command).args(arguments.iter()).status() {
            Ok(status) => status.code().unwrap_or(0) as i64,
            Err(_) => -1,
        }
    }

    // the command with `input` written to its standard input and then closed, its output captured as `run` captures it
    pub async fn with_input(
        command: String,
        argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        input: String,
    ) -> RunResult {
        use std::io::Write;
        let arguments = argument_list.borrow();
        let spawned = std::process::Command::new(&command)
            .args(arguments.iter())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(cause) => return RunResult { code: -1, output: String::new(), error: cause.to_string() },
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input.as_bytes());
        }
        match child.wait_with_output() {
            Ok(out) => RunResult {
                code: out.status.code().unwrap_or(0) as i64,
                output: String::from_utf8_lossy(&out.stdout).to_string(),
                error: String::from_utf8_lossy(&out.stderr).to_string(),
            },
            Err(cause) => RunResult { code: -1, output: String::new(), error: cause.to_string() },
        }
    }
}
