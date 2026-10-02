mod process {
    pub fn get_platform() -> String { std::env::consts::OS.to_string() }
    pub fn exit_with(code: i64) { std::process::exit(code as i32); }
}
