// Working directory runtime. Reached only through the public environment API.
mod directory {
    pub fn get() -> String {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    pub fn set(path: String) {
        let _ = std::env::set_current_dir(&path);
    }
}
