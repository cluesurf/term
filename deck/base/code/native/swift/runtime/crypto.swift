import Foundation
import CryptoKit

enum crypto {
    static func sha256(_ input: Data) -> Data { return Data(SHA256.hash(data: input)) }
    static func sha512(_ input: Data) -> Data { return Data(SHA512.hash(data: input)) }
    static func md5(_ input: Data) -> Data { return Data(Insecure.MD5.hash(data: input)) }
    static func hmacSha256(_ key: Data, _ data: Data) -> Data {
        let mac = HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key))
        return Data(mac)
    }
    static func hmacSha512(_ key: Data, _ data: Data) -> Data {
        let mac = HMAC<SHA512>.authenticationCode(for: data, using: SymmetricKey(data: key))
        return Data(mac)
    }
    static func randomBytes(_ size: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        var bytes = [UInt8]()
        for _ in 0..<size { bytes.append(UInt8.random(in: UInt8.min...UInt8.max, using: &generator)) }
        return Data(bytes)
    }
    // equal without leaking where they differ: every byte is read whatever the earlier ones held. A length difference
    // answers at once
    private static func hmac256(_ key: Data, _ parts: [Data]) -> Data {
        var mac = HMAC<SHA256>(key: SymmetricKey(data: key))
        for part in parts { mac.update(data: part) }
        return Data(mac.finalize())
    }
    // PBKDF2 over HMAC-SHA256 (RFC 8018), written out so its bytes are the other backends' by construction
    static func pbkdf2Sha256(_ password: Data, _ salt: Data, _ iterations: Int, _ length: Int) -> Data {
        var out = Data()
        var block: UInt32 = 1
        while out.count < length {
            let index = Data([UInt8(block >> 24 & 0xff), UInt8(block >> 16 & 0xff), UInt8(block >> 8 & 0xff), UInt8(block & 0xff)])
            var u = hmac256(password, [salt, index])
            var t = [UInt8](u)
            if iterations > 1 {
                for _ in 1..<iterations {
                    u = hmac256(password, [u])
                    let next = [UInt8](u)
                    for k in 0..<t.count { t[k] ^= next[k] }
                }
            }
            out.append(contentsOf: t)
            block += 1
        }
        return out.prefix(max(length, 0))
    }
    // HKDF over HMAC-SHA256 (RFC 5869): extract with the salt (32 zero bytes when empty), then expand with the info
    static func hkdfSha256(_ key: Data, _ salt: Data, _ info: Data, _ length: Int) -> Data {
        let prk = hmac256(salt.isEmpty ? Data(count: 32) : salt, [key])
        var out = Data()
        var t = Data()
        var i: UInt8 = 1
        while out.count < length {
            t = hmac256(prk, [t, info, Data([i])])
            out.append(t)
            i = i &+ 1
        }
        return out.prefix(max(length, 0))
    }
    static func equalSecret(_ a: Data, _ b: Data) -> Bool {
        if a.count != b.count { return false }
        var diff: UInt8 = 0
        for (x, y) in zip(a, b) { diff |= x ^ y }
        return diff == 0
    }
}
