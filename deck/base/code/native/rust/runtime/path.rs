mod path {
    use std::path::Path;
    pub fn join(base: String, name: String) -> String {
        Path::new(&base).join(&name).to_string_lossy().to_string()
    }
    pub fn directory(target: String) -> String {
        Path::new(&target).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    }
    pub fn file_name(target: String) -> String {
        Path::new(&target).file_name().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    }
    pub fn file_extension(target: String) -> String {
        Path::new(&target).extension().map(|p| format!(".{}", p.to_string_lossy())).unwrap_or_default()
    }
    pub fn is_absolute(target: String) -> bool {
        Path::new(&target).is_absolute()
    }
}
