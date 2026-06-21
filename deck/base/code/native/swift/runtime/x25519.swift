import Foundation
import CryptoKit

// X25519 ECDH over CryptoKit. The private key and public key are raw 32-byte representations; the shared secret is the
// raw 32-byte X25519 output. make-key-pair returns the private key and public key concatenated as hex.
enum x25519 {
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
        let secret = Curve25519.KeyAgreement.PrivateKey()
        return toHex(secret.rawRepresentation) + toHex(secret.publicKey.rawRepresentation)
    }
    static func sharedSecret(_ privateHex: String, _ publicHex: String) -> String {
        let secret = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: fromHex(privateHex))
        let publicKey = try! Curve25519.KeyAgreement.PublicKey(rawRepresentation: fromHex(publicHex))
        let shared = try! secret.sharedSecretFromKeyAgreement(with: publicKey)
        return shared.withUnsafeBytes { toHex(Data($0)) }
    }
}
