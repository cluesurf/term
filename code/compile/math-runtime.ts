// Native math runtimes. The public `math` interface delegates the host-equivalent operations (abs, min, max, pow,
// sign, sqrt, floor, ceil, round) to a per-target `math` namespace. On the node target that namespace IS the JS `Math`
// global. On compiled targets the operations are value methods or scattered functions, not a namespace, so each links
// a tiny `math` shim — the same idea as the IO runtime. The shim exposes exactly the names node's `Math` does, so the
// `native/<target>/math` module is identical to the node one apart from which namespace it docks. Pure string
// constants, browser-safe.

// Rust: a crate-root module `math` over i64 (the backend's number type). Referenced as `math::abs(...)` etc. from the
// emitted code (the `<global:math>` dock emits no `use`). Prepend before compiling a program that uses math.
export const SEED_MATH_RUNTIME_RUST = `mod math {
    pub fn abs(v: i64) -> i64 { v.abs() }
    pub fn min(a: i64, b: i64) -> i64 { a.min(b) }
    pub fn max(a: i64, b: i64) -> i64 { a.max(b) }
    pub fn pow(base: i64, exponent: i64) -> i64 { base.pow(exponent as u32) }
    pub fn sign(v: i64) -> i64 { v.signum() }
    pub fn sqrt(v: i64) -> i64 { (v as f64).sqrt() as i64 }
    pub fn floor(v: i64) -> i64 { v }
    pub fn ceil(v: i64) -> i64 { v }
    pub fn round(v: i64) -> i64 { v }
}
`

// Swift: an enum namespace `math` over Int. Foundation supplies `pow`. Referenced as `math.abs(...)`.
export const SEED_MATH_RUNTIME_SWIFT = `import Foundation

enum math {
    static func abs(_ v: Int) -> Int { return Swift.abs(v) }
    static func min(_ a: Int, _ b: Int) -> Int { return Swift.min(a, b) }
    static func max(_ a: Int, _ b: Int) -> Int { return Swift.max(a, b) }
    static func pow(_ base: Int, _ exponent: Int) -> Int { return Int(Foundation.pow(Double(base), Double(exponent))) }
    static func sign(_ v: Int) -> Int { return v > 0 ? 1 : (v < 0 ? -1 : 0) }
    static func sqrt(_ v: Int) -> Int { return Int(Double(v).squareRoot()) }
    static func floor(_ v: Int) -> Int { return v }
    static func ceil(_ v: Int) -> Int { return v }
    static func round(_ v: Int) -> Int { return v }
}
`

// Kotlin/JVM: an object namespace `math` over Long. Referenced as `math.abs(...)`.
export const SEED_MATH_RUNTIME_KOTLIN = `object math {
    fun abs(v: Long): Long = kotlin.math.abs(v)
    fun min(a: Long, b: Long): Long = minOf(a, b)
    fun max(a: Long, b: Long): Long = maxOf(a, b)
    fun pow(base: Long, exponent: Long): Long = Math.pow(base.toDouble(), exponent.toDouble()).toLong()
    fun sign(v: Long): Long = v.compareTo(0L).toLong()
    fun sqrt(v: Long): Long = Math.sqrt(v.toDouble()).toLong()
    fun floor(v: Long): Long = v
    fun ceil(v: Long): Long = v
    fun round(v: Long): Long = v
}
`
