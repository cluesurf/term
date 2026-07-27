mod console {
    pub fn write_line(message: String) { println!("{}", message); }
    pub fn write_error(message: String) { eprintln!("{}", message); }
}
