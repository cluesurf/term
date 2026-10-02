mod io {
    pub fn file_read(path: String) -> String {
        std::fs::read_to_string(&path).unwrap_or_default()
    }
    pub fn file_write(path: String, data: String) {
        let _ = std::fs::write(&path, data);
    }
    pub fn file_read_bytes(path: String) -> Vec<u8> {
        std::fs::read(&path).unwrap_or_default()
    }
    pub fn file_write_bytes(path: String, data: Vec<u8>) {
        let _ = std::fs::write(&path, data);
    }
    pub fn file_append(path: String, data: String) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(data.as_bytes());
        }
    }
    pub fn file_remove(path: String) {
        let _ = std::fs::remove_file(&path);
    }
    pub fn file_copy(from: String, to: String) {
        let _ = std::fs::copy(&from, &to);
    }
    pub fn file_move(from: String, to: String) {
        let _ = std::fs::rename(&from, &to);
    }
    pub fn file_exists(path: String) -> bool {
        std::path::Path::new(&path).exists()
    }
    pub fn file_size(path: String) -> i64 {
        std::fs::metadata(&path).map(|m| m.len() as i64).unwrap_or(0)
    }
    pub fn is_directory(path: String) -> bool {
        std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false)
    }
    pub fn is_file(path: String) -> bool {
        std::fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false)
    }
    pub fn dir_make(path: String) {
        let _ = std::fs::create_dir_all(&path);
    }
    pub fn dir_remove(path: String) {
        let _ = std::fs::remove_dir_all(&path);
    }
    pub fn dir_list(path: String) -> Vec<String> {
        match std::fs::read_dir(&path) {
            Ok(entries) => entries
                .filter_map(|entry| entry.ok().map(|e| e.file_name().to_string_lossy().to_string()))
                .collect(),
            Err(_) => Vec::new(),
        }
    }
    pub fn dir_walk(path: String) -> Vec<String> {
        fn collect(dir: &std::path::Path, out: &mut Vec<String>) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let child = entry.path();
                    out.push(child.to_string_lossy().to_string());
                    if child.is_dir() {
                        collect(&child, out);
                    }
                }
            }
        }
        let mut out = Vec::new();
        collect(std::path::Path::new(&path), &mut out);
        out
    }
}
