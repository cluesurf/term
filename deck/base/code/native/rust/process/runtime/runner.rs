// Subprocess runner over std::process::Command. Runs the command to completion, capturing stdout and stderr, and
// returns the exit code with both streams. A spawn failure returns code -1 and the error text, so the public run API
// stays total. Reached only through the public run API.
mod runner {
    use super::RunResult;
    pub async fn run(command: String, argument_list: Vec<String>) -> RunResult {
        match std::process::Command::new(&command).args(&argument_list).output() {
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
}
