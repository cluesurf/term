// Native cryptography runtimes. Crypto must NEVER be reimplemented by hand: each target wraps its platform's audited,
// built-in crypto library. The public `cryptography/digest` and `cryptography/hmac` interfaces forward to a per-target
// `crypto` namespace. On node that namespace is the `node:crypto` module directly (see native/node/cryptography/*).
// On the compiled targets the platform exposes crypto through value methods / static helpers, not a single namespace,
// so each links a thin `crypto` shim that calls the real library: Swift -> CryptoKit, Kotlin -> java.security /
// javax.crypto, Rust -> the RustCrypto crates (sha2, hmac). The shim only adapts the call shape; the cryptography is
// the platform's. Pure string constants, browser-safe.

// Swift: CryptoKit (system framework, ships with the toolchain on Apple platforms). Digests are formatted to lowercase
// hex with Foundation. Referenced as `crypto.sha256(...)` from the emitted code (the `<global:crypto>` dock emits no
// import; the shim carries its own).
export const SEED_CRYPTO_RUNTIME_SWIFT = `import Foundation
import CryptoKit

enum crypto {
    private static func hex<D: Sequence>(_ bytes: D) -> String where D.Element == UInt8 {
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
    static func sha256(_ input: String) -> String { return hex(SHA256.hash(data: Data(input.utf8))) }
    static func sha512(_ input: String) -> String { return hex(SHA512.hash(data: Data(input.utf8))) }
    static func md5(_ input: String) -> String { return hex(Insecure.MD5.hash(data: Data(input.utf8))) }
    static func hmacSha256(_ key: String, _ data: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(data.utf8), using: SymmetricKey(data: Data(key.utf8)))
        return hex(mac)
    }
    static func hmacSha512(_ key: String, _ data: String) -> String {
        let mac = HMAC<SHA512>.authenticationCode(for: Data(data.utf8), using: SymmetricKey(data: Data(key.utf8)))
        return hex(mac)
    }
}
`

// Kotlin/JVM: java.security.MessageDigest and javax.crypto.Mac (both ship with the JDK).
export const SEED_CRYPTO_RUNTIME_KOTLIN = `import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object crypto {
    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
    private fun digest(algorithm: String, input: String): String = hex(MessageDigest.getInstance(algorithm).digest(input.toByteArray(Charsets.UTF_8)))
    fun sha256(input: String): String = digest("SHA-256", input)
    fun sha512(input: String): String = digest("SHA-512", input)
    fun md5(input: String): String = digest("MD5", input)
    private fun mac(algorithm: String, key: String, data: String): String {
        val instance = Mac.getInstance(algorithm)
        instance.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), algorithm))
        return hex(instance.doFinal(data.toByteArray(Charsets.UTF_8)))
    }
    fun hmacSha256(key: String, data: String): String = mac("HmacSHA256", key, data)
    fun hmacSha512(key: String, data: String): String = mac("HmacSHA512", key, data)
}
`

// Browser: the Web Crypto API (globalThis.crypto.subtle). Its digest is asynchronous (returns a Promise<ArrayBuffer>),
// which is why the whole cryptography interface is async on every target. The shim is a JS namespace `crypto` whose
// methods await subtle and format to hex; it reads the real Web Crypto through `globalThis.crypto` so naming the shim
// `crypto` does not shadow it. HMAC uses subtle's importKey + sign. Prepended to emitted browser code.
export const SEED_CRYPTO_RUNTIME_BROWSER = `const crypto = (() => {
  const hex = (buffer) => Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
  const bytes = (text) => new TextEncoder().encode(text)
  const digest = async (algorithm, input) => hex(await globalThis.crypto.subtle.digest(algorithm, bytes(input)))
  const mac = async (algorithm, key, data) => {
    const cryptoKey = await globalThis.crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: algorithm }, false, ['sign'])
    return hex(await globalThis.crypto.subtle.sign('HMAC', cryptoKey, bytes(data)))
  }
  return {
    sha256: (input) => digest('SHA-256', input),
    sha512: (input) => digest('SHA-512', input),
    md5: (input) => { throw new Error('MD5 is not available in the Web Crypto API') },
    hmacSha256: (key, data) => mac('SHA-256', key, data),
    hmacSha512: (key, data) => mac('SHA-512', key, data),
  }
})()
`

// Rust: the RustCrypto crates (sha2, hmac). These are external dependencies, so a program using crypto must be built
// through cargo with `sha2` and `hmac` in its manifest (a bare single-file rustc invocation cannot resolve them). The
// shim only adapts the call shape.
export const SEED_CRYPTO_RUNTIME_RUST = `mod crypto {
    use sha2::{Sha256, Sha512, Digest};
    use hmac::{Hmac, Mac};
    pub fn sha256(input: String) -> String { format!("{:x}", Sha256::digest(input.as_bytes())) }
    pub fn sha512(input: String) -> String { format!("{:x}", Sha512::digest(input.as_bytes())) }
    pub fn md5(input: String) -> String { format!("{:x}", md5::compute(input.as_bytes())) }
    pub fn hmac_sha256(key: String, data: String) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
        mac.update(data.as_bytes());
        format!("{:x}", mac.finalize().into_bytes())
    }
    pub fn hmac_sha512(key: String, data: String) -> String {
        let mut mac = Hmac::<Sha512>::new_from_slice(key.as_bytes()).unwrap();
        mac.update(data.as_bytes());
        format!("{:x}", mac.finalize().into_bytes())
    }
}
`
