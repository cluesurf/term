// Line reading for the rust target, over tokio's asynchronous standard input. The reader is held rather than
// rebuilt per call, because a BufReader keeps whatever it read past the newline: build a new one each time and
// the second line is the one the first read already swallowed.
//
// Reached only through the public process/line API.
mod prompt {
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdin};
    use tokio::sync::Mutex;

    pub type Tool = Arc<Mutex<BufReader<Stdin>>>;

    pub async fn line_open() -> Tool {
        Arc::new(Mutex::new(BufReader::new(tokio::io::stdin())))
    }

    pub async fn line_ask(tool: Tool, prompt: String) -> String {
        let mut out = tokio::io::stdout();
        let _ = out.write_all(prompt.as_bytes()).await;
        let _ = out.flush().await;

        line_read(tool).await
    }

    // the line without its newline, or "" at the end of input
    pub async fn line_read(tool: Tool) -> String {
        let mut line = String::new();

        match tool.lock().await.read_line(&mut line).await {
            Ok(0) | Err(_) => String::new(),
            Ok(_) => line.trim_end_matches('\n').trim_end_matches('\r').to_string(),
        }
    }

    // standard input is not ours to close: the tool is dropped, the descriptor stays as the process found it
    pub async fn line_close(_tool: Tool) {}
}
