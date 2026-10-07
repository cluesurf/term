// Whole-path file calls for the rust target that never await, over `std::fs`. `stat_path` and `list_path` build the
// emitted `StatRaw` and `EntryRaw` records directly (the shim is prepended to the module that declares them, so the
// types are in scope through `use super::*`), one call each. `changed` is seconds times 1000 plus nanoseconds over
// 1e6 in a double, the arithmetic node's `mtimeMs` is.
//
// Reached only through the public file/blocking API, which has already ruled out a missing path.
mod blocking {
    use super::{EntryRaw, StatRaw};
    use std::os::unix::fs::MetadataExt;

    pub fn read_path(path: String) -> String {
        match std::fs::read(&path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            Err(_) => String::new(),
        }
    }

    // a symbolic link is followed, so a link to nothing is not there
    pub fn exists_path(path: String) -> bool {
        std::path::Path::new(&path).exists()
    }

    pub fn stat_path(path: String) -> StatRaw {
        match std::fs::metadata(&path) {
            Ok(meta) => StatRaw {
                kind: if meta.is_dir() {
                    "directory".to_string()
                } else if meta.is_file() {
                    "file".to_string()
                } else {
                    "other".to_string()
                },
                size: meta.len() as i64,
                changed: meta.mtime() as f64 * 1000.0 + meta.mtime_nsec() as f64 / 1e6,
            },
            Err(_) => StatRaw {
                kind: "other".to_string(),
                size: 0,
                changed: 0.0,
            },
        }
    }

    // the platform's own order, no `.` or `..`, each kind the entry's own with links not followed
    pub fn list_path(path: String) -> Vec<EntryRaw> {
        let mut out = Vec::new();

        if let Ok(entries) = std::fs::read_dir(&path) {
            for entry in entries.flatten() {
                let kind = match entry.file_type() {
                    Ok(kind) if kind.is_dir() => "directory",
                    Ok(kind) if kind.is_symlink() => "link",
                    Ok(kind) if kind.is_file() => "file",
                    _ => "other",
                };

                out.push(EntryRaw {
                    name: entry.file_name().to_string_lossy().to_string(),
                    kind: kind.to_string(),
                });
            }
        }

        out
    }

    pub fn real_path(path: String) -> String {
        match std::fs::canonicalize(&path) {
            Ok(real) => real.to_string_lossy().to_string(),
            Err(_) => path,
        }
    }
}
