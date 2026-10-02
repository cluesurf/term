// Standard user folders. Reached only through the public environment API. Each folder follows the host convention:
// the Apple layout under `~/Library`, the Windows `APPDATA` / `LOCALAPPDATA` pair, and the XDG base directories
// elsewhere, falling back to the documented default when the XDG variable is unset.
mod folder {
    fn home_or_empty() -> String {
        std::env::var("HOME").unwrap_or_default()
    }

    fn xdg_or(variable: &str, fallback: &str) -> String {
        match std::env::var(variable) {
            Ok(value) => value,
            Err(_) => format!("{}/{}", home_or_empty(), fallback),
        }
    }

    pub fn home() -> String {
        home_or_empty()
    }

    pub fn temporary() -> String {
        std::env::temp_dir().to_string_lossy().to_string()
    }

    pub fn data() -> String {
        if cfg!(target_os = "macos") {
            format!("{}/Library/Application Support", home_or_empty())
        } else if cfg!(target_os = "windows") {
            std::env::var("APPDATA").unwrap_or_default()
        } else {
            xdg_or("XDG_DATA_HOME", ".local/share")
        }
    }

    pub fn configuration() -> String {
        if cfg!(target_os = "macos") {
            format!("{}/Library/Preferences", home_or_empty())
        } else if cfg!(target_os = "windows") {
            std::env::var("APPDATA").unwrap_or_default()
        } else {
            xdg_or("XDG_CONFIG_HOME", ".config")
        }
    }

    pub fn cache() -> String {
        if cfg!(target_os = "macos") {
            format!("{}/Library/Caches", home_or_empty())
        } else if cfg!(target_os = "windows") {
            format!(
                "{}\\Temp",
                std::env::var("LOCALAPPDATA").unwrap_or_default()
            )
        } else {
            xdg_or("XDG_CACHE_HOME", ".cache")
        }
    }
}
