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
}
