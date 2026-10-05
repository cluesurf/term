mod console {
    // the text as given, flushed, since stdout is line-buffered and a prompt has no newline to flush it
    pub fn write_text(message: String) { use std::io::Write; print!("{}", message); let _ = std::io::stdout().flush(); }
    pub fn write_line(message: String) { println!("{}", message); }
    pub fn write_error(message: String) { eprintln!("{}", message); }
}
