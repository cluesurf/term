// Directory reading for the rust target, over `std::fs::read_dir` handed back to the program's loop
// (`crate::__term_hand_back`, decision 001). `dir_list` is one level or every level as a list of relative paths;
// `dir_walk` is every level as `WalkEntry` records (path, kind, depth), which is the form the module that docks this
// declares. Reached only through the public file/directory API.
mod walk_file {
    use super::WalkEntry;

    pub async fn dir_make(path: String) {
        crate::__term_hand_back(move || {
            let _ = std::fs::create_dir_all(&path);
        })
        .await
    }

    // one level, or every level below it as paths relative to `path`
    pub async fn dir_list(path: String, deep: bool) -> Vec<String> {
        crate::__term_hand_back(move || {
            let mut out = Vec::new();

            if deep {
                list_deep(path.into(), String::new(), &mut out);
            } else if let Ok(entries) = std::fs::read_dir(&path) {
                for entry in entries.flatten() {
                    out.push(entry.file_name().to_string_lossy().to_string());
                }
            }

            out
        })
        .await
    }

    fn list_deep(base: std::path::PathBuf, prefix: String, out: &mut Vec<String>) {
        let entries = match std::fs::read_dir(&base) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let relative = if prefix.is_empty() { name.clone() } else { format!("{}/{}", prefix, name) };

            out.push(relative.clone());

            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                list_deep(entry.path(), relative, out);
            }
        }
    }

    // every entry beneath `path`, with what it is and how far below the root it sits. `depth` 0 walks all the way
    // down, which is what node's own recursive readdir does.
    pub async fn dir_walk(path: String, depth: i64) -> Vec<WalkEntry> {
        crate::__term_hand_back(move || {
            let mut out = Vec::new();
            step(path.into(), 0, depth, &mut out);

            out
        })
        .await
    }

    fn step(at: std::path::PathBuf, level: i64, max: i64, out: &mut Vec<WalkEntry>) {
        let entries = match std::fs::read_dir(&at) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        for entry in entries.flatten() {
            let kind = match entry.file_type() {
                Ok(kind) if kind.is_dir() => "directory",
                Ok(kind) if kind.is_symlink() => "link",
                Ok(_) => "file",
                Err(_) => continue,
            };

            out.push(WalkEntry {
                path: entry.path().to_string_lossy().to_string(),
                kind: kind.to_string(),
                depth: level,
            });

            if kind == "directory" && (max == 0 || level + 1 < max) {
                step(entry.path(), level + 1, max, out);
            }
        }
    }
}
