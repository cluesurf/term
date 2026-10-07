// Subprocess runner over std::process::Command. Runs the command to completion, capturing stdout and stderr, and
// returns the exit code with both streams. A spawn failure returns code -1 and the error text, so the public run API
// stays total. A child a signal ended answers code 128 plus the signal's number and `signal` that number; one that
// exited by itself answers its code and signal 0. `directory` (empty is this process's own) and `environment`
// (entries added over the inherited one) shape the child; a directory that is not there fails the spawn, as a missing
// command does. Reached only through the public run API.
mod runner {
    use super::RunResult;

    type Environment = std::rc::Rc<std::cell::RefCell<crate::TermMap<String, String>>>;

    // the command with its arguments, working directory and added variables
    fn shaped(
        command: &str,
        argument_list: &std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        directory: &str,
        environment: &Environment,
    ) -> std::process::Command {
        let mut shaped = std::process::Command::new(command);
        shaped.args(argument_list.borrow().iter());
        if !directory.is_empty() {
            shaped.current_dir(directory);
        }
        for (name, value) in environment.borrow().iter() {
            shaped.env(name.as_str(), value.as_str());
        }
        shaped
    }

    // the exit code a status answers and its signal: a signal death is 128 plus the signal, an exit by itself is its
    // own code and signal 0
    fn finished(status: std::process::ExitStatus) -> (i64, i64) {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(signal) = status.signal() {
                return (128 + signal as i64, signal as i64);
            }
        }
        (status.code().unwrap_or(0) as i64, 0)
    }

    fn answered(out: std::process::Output) -> RunResult {
        let (code, signal) = finished(out.status);
        RunResult {
            code,
            output: String::from_utf8_lossy(&out.stdout).to_string(),
            error: String::from_utf8_lossy(&out.stderr).to_string(),
            signal,
        }
    }

    fn refused(cause: std::io::Error) -> RunResult {
        RunResult { code: -1, output: String::new(), error: cause.to_string(), signal: 0 }
    }

    // `argument_list` arrives as the seed list representation (a reference-counted mutable vec); borrow it to read the
    // arguments without taking ownership.
    pub async fn run(
        command: String,
        argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        directory: String,
        environment: Environment,
    ) -> RunResult {
        match shaped(&command, &argument_list, &directory, &environment).output() {
            Ok(out) => answered(out),
            Err(cause) => refused(cause),
        }
    }

    // the command on this terminal: it reads the keyboard and writes as it goes; its exit code (128 plus the signal for
    // a signal death), -1 when it could not start
    pub async fn attached(
        command: String,
        argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        directory: String,
        environment: Environment,
    ) -> i64 {
        match shaped(&command, &argument_list, &directory, &environment).status() {
            Ok(status) => finished(status).0,
            Err(_) => -1,
        }
    }

    // the command with `input` written to its standard input and then closed, its output captured as `run` captures it
    pub async fn with_input(
        command: String,
        argument_list: std::rc::Rc<std::cell::RefCell<Vec<String>>>,
        input: String,
        directory: String,
        environment: Environment,
    ) -> RunResult {
        use std::io::Write;
        let spawned = shaped(&command, &argument_list, &directory, &environment)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(cause) => return refused(cause),
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(input.as_bytes());
        }
        match child.wait_with_output() {
            Ok(out) => answered(out),
            Err(cause) => refused(cause),
        }
    }
}
