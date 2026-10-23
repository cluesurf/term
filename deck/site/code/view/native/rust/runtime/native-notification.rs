// A local notification for a Rust program (term-device-layer-0001), docked by ../notification.tree as
// `<global:native-notification>`. No crate: `notify-send` on Linux (libnotify, which asks the session's notification
// server over D-Bus), a toast through the WinRT ToastNotificationManager from PowerShell on Windows, and
// `display notification` through `osascript` on a Mac. The title and the body reach each tool as arguments or through
// the environment, never inside a script, so no text an app passes is ever read as code.
mod native_notification {
    use std::process::{Command, Stdio};

    // the toast, from Windows PowerShell 5, which can load WinRT types; the AppUserModelID is PowerShell's own, so
    // the toast is shown without an installed shortcut
    const TOAST: &str = "$ErrorActionPreference = 'Stop'; \
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; \
        $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); \
        $texts = $xml.GetElementsByTagName('text'); \
        $texts.Item(0).AppendChild($xml.CreateTextNode($env:TERM_NOTIFICATION_TITLE)) | Out-Null; \
        $texts.Item(1).AppendChild($xml.CreateTextNode($env:TERM_NOTIFICATION_BODY)) | Out-Null; \
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml); \
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)";

    // shown when the platform took it, failed when the tool ran and refused (no notification server on Linux, a toast
    // the system would not show), unavailable when the platform has no such tool
    pub fn post(title: String, body: String) -> String {
        let ran = if cfg!(windows) {
            Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", TOAST])
                .env("TERM_NOTIFICATION_TITLE", &title)
                .env("TERM_NOTIFICATION_BODY", &body)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
        } else if cfg!(target_os = "macos") {
            Command::new("osascript")
                .args(["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", &title, &body])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
        } else {
            // `--` ends the options, so a title that begins with a dash is a title
            Command::new("notify-send").args(["--", &title, &body]).stdout(Stdio::null()).stderr(Stdio::null()).status()
        };
        match ran {
            Ok(status) if status.success() => "shown".to_string(),
            Ok(_) => "failed".to_string(),
            Err(_) => "unavailable".to_string(),
        }
    }
}
