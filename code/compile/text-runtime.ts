// Native string runtimes. The public `text/string` interface forwards to a per-target string implementation. On node
// and browser the host String methods are clean member calls, so those native modules call them directly (no shim).
// On the compiled targets the method names and shapes differ (toUpperCase vs to_uppercase vs uppercased vs uppercase;
// Swift trim / repeat / replace are not plain member calls), so each links a thin `text` shim that presents the eight
// operations uniformly over the platform's own string API. The shim adapts the call shape; the string operation is the
// platform's. Pure string constants, browser-safe.

// Rust: `String` methods. `trim` returns a slice, so it is re-owned. Referenced as `text::upper(...)` etc.
export const SEED_TEXT_RUNTIME_RUST = `mod text {
    pub fn upper(s: String) -> String { s.to_uppercase() }
    pub fn lower(s: String) -> String { s.to_lowercase() }
    pub fn trim(s: String) -> String { s.trim().to_string() }
    pub fn repeated(s: String, n: i64) -> String { s.repeat(n as usize) }
    pub fn contains(s: String, part: String) -> bool { s.contains(&part) }
    pub fn starts_with(s: String, prefix: String) -> bool { s.starts_with(&prefix) }
    pub fn ends_with(s: String, suffix: String) -> bool { s.ends_with(&suffix) }
    pub fn replace(s: String, from: String, to: String) -> String { s.replace(&from, &to) }
}
`

// Swift: Foundation supplies trimming and replacement. `repeat` is a keyword, so the function is `repeated`.
export const SEED_TEXT_RUNTIME_SWIFT = `import Foundation

enum text {
    static func upper(_ s: String) -> String { return s.uppercased() }
    static func lower(_ s: String) -> String { return s.lowercased() }
    static func trim(_ s: String) -> String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
    static func repeated(_ s: String, _ n: Int) -> String { return String(repeating: s, count: n) }
    static func contains(_ s: String, _ part: String) -> Bool { return s.contains(part) }
    static func startsWith(_ s: String, _ prefix: String) -> Bool { return s.hasPrefix(prefix) }
    static func endsWith(_ s: String, _ suffix: String) -> Bool { return s.hasSuffix(suffix) }
    static func replace(_ s: String, _ from: String, _ to: String) -> String { return s.replacingOccurrences(of: from, with: to) }
}
`

// Kotlin: kotlin.text String functions, all clean.
export const SEED_TEXT_RUNTIME_KOTLIN = `object text {
    fun upper(s: String): String = s.uppercase()
    fun lower(s: String): String = s.lowercase()
    fun trim(s: String): String = s.trim()
    fun repeated(s: String, n: Long): String = s.repeat(n.toInt())
    fun contains(s: String, part: String): Boolean = s.contains(part)
    fun startsWith(s: String, prefix: String): Boolean = s.startsWith(prefix)
    fun endsWith(s: String, suffix: String): Boolean = s.endsWith(suffix)
    fun replace(s: String, from: String, to: String): String = s.replace(from, to)
}
`
