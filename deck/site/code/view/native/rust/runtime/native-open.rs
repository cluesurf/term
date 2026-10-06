// Handing an address to the platform for a Rust program (device-layer-0014), docked by ../open.tree as
// `<global:native-open>`. No crate: `xdg-open` on Linux, the URL handler Windows registers (`url.dll`, which answers
// whether something took the address rather than showing a dialog), and `open` on a Mac. There is no share sheet on a
// desktop, so sharing answers `unavailable`.
mod native_open {
    use std::process::{Command, Stdio};

    // opened, or unavailable when nothing handles the address (or it is not one)
    pub fn address(address: String) -> String {
        // an address is a scheme and a colon, so a path or a word never reaches the platform's opener
        let scheme = address.split(':').next().unwrap_or("");
        if !address.contains(':') || scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
            return "unavailable".to_string();
        }
        let ran = if cfg!(windows) {
            Command::new("rundll32").args(["url.dll,FileProtocolHandler", &address]).stdout(Stdio::null()).stderr(Stdio::null()).status()
        } else if cfg!(target_os = "macos") {
            Command::new("open").arg(&address).stdout(Stdio::null()).stderr(Stdio::null()).status()
        } else {
            Command::new("xdg-open").arg(&address).stdout(Stdio::null()).stderr(Stdio::null()).status()
        };
        if ran.map(|status| status.success()).unwrap_or(false) { "opened".to_string() } else { "unavailable".to_string() }
    }
}
