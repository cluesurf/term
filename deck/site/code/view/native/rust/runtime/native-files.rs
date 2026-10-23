// A file the person picks, for a Rust program (term-device-layer-0001), docked by ../files.tree as
// `<global:native-files>`. No crate: the platform's own open dialog through the tool every desktop of its kind has,
// `zenity --file-selection` (GTK) or `kdialog --getopenfilename` (KDE) on Linux, an OpenFileDialog from PowerShell on
// Windows, and `choose file` through `osascript` on a Mac. What the person chose is copied into a folder of the app's
// own under the temporary directory, its last part the name the person saw, so the app reads a file of its own and
// never a location it was lent, as on Apple.
mod native_files {
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static PICKED: AtomicUsize = AtomicUsize::new(0);

    // the dialog, from Windows PowerShell; the filter through the environment, so no text is read as script
    const DIALOG: &str = "Add-Type -AssemblyName System.Windows.Forms; \
        $dialog = New-Object System.Windows.Forms.OpenFileDialog; \
        $dialog.Filter = $env:TERM_PICK_FILTER; \
        if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) } else { exit 1 }";

    const AUDIO: [&str; 8] = ["wav", "mp3", "m4a", "aac", "flac", "ogg", "aif", "aiff"];

    // the extensions a kind offers, none for anything
    fn extensions(kind: &str) -> Vec<&'static str> {
        match kind {
            "audio" => AUDIO.to_vec(),
            "json" => vec!["json"],
            _ => vec![],
        }
    }

    // what one dialog said: the path chosen, a cancel, or no such tool
    enum Asked {
        Chose(String),
        Cancelled,
        Missing,
    }

    fn ask(command: &mut Command) -> Asked {
        match command.stdin(Stdio::null()).stderr(Stdio::null()).output() {
            Ok(output) if output.status.success() => {
                let path = String::from_utf8_lossy(&output.stdout).trim_end_matches(['\r', '\n']).to_string();
                if path.is_empty() { Asked::Cancelled } else { Asked::Chose(path) }
            }
            Ok(_) => Asked::Cancelled,
            Err(_) => Asked::Missing,
        }
    }

    fn dialog(kind: &str) -> Asked {
        let offered = extensions(kind);
        if cfg!(windows) {
            let filter = if offered.is_empty() {
                "All files|*.*".to_string()
            } else {
                let patterns = offered.iter().map(|one| format!("*.{}", one)).collect::<Vec<_>>().join(";");
                format!("{}|{}", kind, patterns)
            };
            return ask(Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-STA", "-Command", DIALOG]).env("TERM_PICK_FILTER", filter));
        }
        if cfg!(target_os = "macos") {
            // the types as uniform type identifiers, the kinds macOS filters by
            let script = match kind {
                "audio" => "POSIX path of (choose file of type {\"public.audio\"})",
                "json" => "POSIX path of (choose file of type {\"public.json\"})",
                _ => "POSIX path of (choose file)",
            };
            return ask(Command::new("osascript").args(["-e", script]));
        }
        let mut zenity = Command::new("zenity");
        zenity.arg("--file-selection");
        if !offered.is_empty() {
            let patterns = offered.iter().map(|one| format!("*.{}", one)).collect::<Vec<_>>().join(" ");
            zenity.arg(format!("--file-filter={} | {}", kind, patterns));
        }
        match ask(&mut zenity) {
            Asked::Missing => {
                let filter = offered.iter().map(|one| format!("*.{}", one)).collect::<Vec<_>>().join(" ");
                ask(Command::new("kdialog").args(["--getopenfilename", ".", &filter]))
            }
            answered => answered,
        }
    }

    // `file <path>` (the copy), cancelled, or unavailable where no dialog could be put up or the choice was not a file
    pub fn pick(kind: String) -> String {
        match dialog(&kind) {
            Asked::Missing => "unavailable".to_string(),
            Asked::Cancelled => "cancelled".to_string(),
            Asked::Chose(path) => {
                let source = Path::new(&path);
                let name = match source.file_name() {
                    Some(name) if source.is_file() => name.to_owned(),
                    _ => return "unavailable".to_string(),
                };
                let folder = std::env::temp_dir().join(format!("term-picked-{}-{}", std::process::id(), PICKED.fetch_add(1, Ordering::SeqCst)));
                let copy = folder.join(name);
                match std::fs::create_dir_all(&folder).and_then(|_| std::fs::copy(source, &copy)) {
                    Ok(_) => format!("file {}", copy.display()),
                    Err(_) => "unavailable".to_string(),
                }
            }
        }
    }
}
