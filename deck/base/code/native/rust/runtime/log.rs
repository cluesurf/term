mod log {
    pub fn write_info(message: String) { println!("{}", message); }
    pub fn write_warn(message: String) { println!("{}", message); }
    pub fn write_error(message: String) { eprintln!("{}", message); }
    pub fn write_debug(message: String) { println!("{}", message); }
}
