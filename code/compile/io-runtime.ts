// Native IO runtimes. Compiled targets (Rust, Swift, Kotlin) reach the host file system through platform APIs that
// return error-carrying types (Rust `Result`, Swift `throws`, Kotlin checked exceptions). The stdlib's public `file`
// API is total — `read` returns a string, `write` returns unit. To bridge the two without leaking error handling into
// every emitted call, each target links a tiny IO runtime: a namespace of clean, total functions that wrap the
// platform API and absorb its error type. The `native/<target>/file` module docks this namespace (as a `<global:io>`
// binding, so no import is emitted) and forwards to it. This mirrors the LLVM string runtime: the language stays
// simple, the platform mess is quarantined in one audited shim. Pure string constants, browser-safe.

// Rust: a crate-root module `io`. Referenced as `io::file_read(...)` from the emitted code (the module is in scope, so
// the `<global:io>` dock emits no `use`). `read_to_string` / `write` errors collapse to an empty string / silent
// no-op — the total API contract. Prepend this to emitted Rust before compiling a program that performs file IO.
export const SEED_IO_RUNTIME_RUST = `mod io {
    pub fn file_read(path: String) -> String {
        std::fs::read_to_string(&path).unwrap_or_default()
    }
    pub fn file_write(path: String, data: String) {
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
}
`

// Swift: an enum namespace `io` of static funcs. Foundation's `String(contentsOfFile:)` / `write(toFile:)` throw, so
// each wrapper uses `try?`. Prepend to emitted Swift (the `<global:io>` dock emits no `import` for the namespace; the
// program still imports Foundation through the runtime's own use of it).
export const SEED_IO_RUNTIME_SWIFT = `import Foundation

enum io {
    static func fileRead(_ path: String) -> String {
        return (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
    }
    static func fileWrite(_ path: String, _ data: String) {
        try? data.write(toFile: path, atomically: true, encoding: .utf8)
    }
    static func fileAppend(_ path: String, _ data: String) {
        let existing = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        try? (existing + data).write(toFile: path, atomically: true, encoding: .utf8)
    }
    static func fileRemove(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }
    static func fileCopy(_ from: String, _ to: String) {
        try? FileManager.default.copyItem(atPath: from, toPath: to)
    }
    static func fileMove(_ from: String, _ to: String) {
        try? FileManager.default.moveItem(atPath: from, toPath: to)
    }
    static func fileExists(_ path: String) -> Bool {
        return FileManager.default.fileExists(atPath: path)
    }
}
`

// Kotlin/JVM: an object namespace `io`. java.nio.file.Files throws checked IOExceptions, so each wrapper catches and
// returns the total result. Prepend to emitted Kotlin.
export const SEED_IO_RUNTIME_KOTLIN = `import java.io.File

object io {
    fun fileRead(path: String): String = try { File(path).readText() } catch (e: Exception) { "" }
    fun fileWrite(path: String, data: String) { try { File(path).writeText(data) } catch (e: Exception) {} }
    fun fileAppend(path: String, data: String) { try { File(path).appendText(data) } catch (e: Exception) {} }
    fun fileRemove(path: String) { try { File(path).delete() } catch (e: Exception) {} }
    fun fileCopy(from: String, to: String) { try { File(from).copyTo(File(to), overwrite = true) } catch (e: Exception) {} }
    fun fileMove(from: String, to: String) { try { File(from).copyTo(File(to), overwrite = true); File(from).delete() } catch (e: Exception) {} }
    fun fileExists(path: String): Boolean = File(path).exists()
}
`
