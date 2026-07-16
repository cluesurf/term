mod environment {
    pub fn current_directory() -> String {
        std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    }
    pub fn get_variable(name: String) -> String {
        std::env::var(&name).unwrap_or_default()
    }
}
