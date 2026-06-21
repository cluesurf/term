import Foundation
import CryptoKit

// Ed25519 signatures over CryptoKit. The private key and public key are raw 32-byte representations; a signature is
// 64 bytes. make-key-pair returns the private key and public key concatenated as hex.
enum eddsa {
    private static func fromHex(_ hex: String) -> Data {
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            data.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return data
    }
    private static func toHex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
    static func makeKeyPair() -> String {
        let signing = Curve25519.Signing.PrivateKey()
        return toHex(signing.rawRepresentation) + toHex(signing.publicKey.rawRepresentation)
    }
    static func sign(_ privateHex: String, _ message: String) -> String {
        let signing = try! Curve25519.Signing.PrivateKey(rawRepresentation: fromHex(privateHex))
        return toHex(try! signing.signature(for: Data(message.utf8)))
    }
    static func verify(_ publicHex: String, _ message: String, _ signatureHex: String) -> Bool {
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: fromHex(publicHex)) else { return false }
        return key.isValidSignature(fromHex(signatureHex), for: Data(message.utf8))
    }
}
