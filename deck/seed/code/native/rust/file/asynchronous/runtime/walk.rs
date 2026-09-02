// Directory reading for the rust target, over `tokio::fs::read_dir`. `dir_list` is one level or every level as a
// list of relative paths; `dir_walk` is every level as `WalkEntry` records (path, kind, depth), which is the form
// the module that docks this declares. Reached only through the public file/directory API.
mod walk_file {
    use super::WalkEntry;

    // an async fn that calls itself needs a boxed future, or its size is infinite
    type Step = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

    pub async fn dir_make(path: String) {
        let _ = tokio::fs::create_dir_all(&path).await;
    }

    // one level, or every level below it as paths relative to `path`
    pub async fn dir_list(path: String, deep: bool) -> Vec<String> {
        let mut out = Vec::new();

        if deep {
            list_deep(path.into(), String::new(), &mut out).await;
        } else {
            if let Ok(mut entries) = tokio::fs::read_dir(&path).await {
                while let Ok(Some(entry)) = entries.next_entry().await {
                    out.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }

        out
    }

    fn list_deep(
        base: std::path::PathBuf,
        prefix: String,
        out: &mut Vec<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let mut entries = match tokio::fs::read_dir(&base).await {
                Ok(entries) => entries,
                Err(_) => return,
            };

            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                let relative = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", prefix, name)
                };

                out.push(relative.clone());

                if entry
                    .file_type()
                    .await
                    .map(|kind| kind.is_dir())
                    .unwrap_or(false)
                {
                    list_deep(entry.path(), relative, out).await;
                }
            }
        })
    }

    // every entry beneath `path`, with what it is and how far below the root it sits. `depth` 0 walks all the way
    // down, which is what node's own recursive readdir does.
    pub async fn dir_walk(
        path: String,
        depth: i64,
    ) -> Vec<WalkEntry> {
        let out = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        step(path.into(), 0, depth, out.clone()).await;
        let entries = out.lock().map(|held| held.clone()).unwrap_or_default();

        entries
    }

    fn step(
        at: std::path::PathBuf,
        level: i64,
        max: i64,
        out: std::sync::Arc<std::sync::Mutex<Vec<WalkEntry>>>,
    ) -> Step {
        Box::pin(async move {
            let mut entries = match tokio::fs::read_dir(&at).await {
                Ok(entries) => entries,
                Err(_) => return,
            };

            while let Ok(Some(entry)) = entries.next_entry().await {
                let kind = match entry.file_type().await {
                    Ok(kind) if kind.is_dir() => "directory",
                    Ok(kind) if kind.is_symlink() => "link",
                    Ok(_) => "file",
                    Err(_) => continue,
                };

                if let Ok(mut held) = out.lock() {
                    held.push(WalkEntry {
                        path: entry.path().to_string_lossy().to_string(),
                        kind: kind.to_string(),
                        depth: level,
                    });
                }

                if kind == "directory" && (max == 0 || level + 1 < max) {
                    step(entry.path(), level + 1, max, out.clone()).await;
                }
            }
        })
    }
}
