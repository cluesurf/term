// Machine facts for rust. The platform and architecture are named as node's `os.platform()` and `os.arch()` name them
// (`macos` is `darwin`, `aarch64` is `arm64`, `x86_64` is `x64`), so a program branches on one set of names. Reached
// only through the public machine API.
mod machine {
    pub fn cores() -> i64 {
        std::thread::available_parallelism().map(|n| n.get() as i64).unwrap_or(1)
    }

    pub fn platform() -> String {
        match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        }
        .to_string()
    }

    pub fn architecture() -> String {
        match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            "x86" => "ia32",
            other => other,
        }
        .to_string()
    }
}
