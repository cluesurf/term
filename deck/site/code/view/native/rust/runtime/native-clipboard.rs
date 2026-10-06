// The clipboard for a Rust program (device-layer-0014), docked by ../clipboard.tree as `<global:native-clipboard>`.
// No crate: the platform's own clipboard tools, through std::process. On Linux the Wayland pair (`wl-copy`,
// `wl-paste`) when a Wayland display is set, else `xclip` or `xsel` on X11; on Windows PowerShell's clipboard; on a Mac
// `pbcopy` and `pbpaste`. A machine with none of them answers `unavailable` and reads empty text, which in a cask sends
// the page to its WebView (../../../hosted.tree).
mod native_clipboard {
    use std::io::Write;
    use std::process::{Command, Stdio};

    // each tool that can write the clipboard here, with its arguments, in the order they are tried
    fn writers() -> Vec<(&'static str, Vec<&'static str>)> {
        if cfg!(windows) {
            vec![("powershell", vec!["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"])]
        } else if cfg!(target_os = "macos") {
            vec![("pbcopy", vec![])]
        } else if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            vec![("wl-copy", vec![]), ("xclip", vec!["-selection", "clipboard"]), ("xsel", vec!["--clipboard", "--input"])]
        } else {
            vec![("xclip", vec!["-selection", "clipboard"]), ("xsel", vec!["--clipboard", "--input"])]
        }
    }

    fn readers() -> Vec<(&'static str, Vec<&'static str>)> {
        if cfg!(windows) {
            vec![("powershell", vec!["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw"])]
        } else if cfg!(target_os = "macos") {
            vec![("pbpaste", vec![])]
        } else if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            vec![("wl-paste", vec!["--no-newline"]), ("xclip", vec!["-selection", "clipboard", "-out"]), ("xsel", vec!["--clipboard", "--output"])]
        } else {
            vec![("xclip", vec!["-selection", "clipboard", "-out"]), ("xsel", vec!["--clipboard", "--output"])]
        }
    }

    // the text on the clipboard now, or empty text when it holds none or nothing here can read it
    pub fn read() -> String {
        for (tool, args) in readers() {
            if let Ok(out) = Command::new(tool).args(&args).stderr(Stdio::null()).output() {
                if out.status.success() {
                    let text = String::from_utf8_lossy(&out.stdout).into_owned();
                    // PowerShell ends its output with a line break the clipboard does not hold
                    return if cfg!(windows) { text.trim_end_matches(['\r', '\n']).to_string() } else { text };
                }
            }
        }
        String::new()
    }

    // `written`, or `unavailable` when no tool here could take it
    pub fn write(text: String) -> String {
        for (tool, args) in writers() {
            let child = Command::new(tool).args(&args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
            if let Ok(mut child) = child {
                if let Some(mut input) = child.stdin.take() {
                    let _ = input.write_all(text.as_bytes());
                }
                if child.wait().map(|status| status.success()).unwrap_or(false) {
                    return "written".to_string();
                }
            }
        }
        "unavailable".to_string()
    }
}
