import Foundation
import CryptoKit

// X25519 ECDH over CryptoKit. Keys and the shared secret are raw bytes (Data): a key-pair is the 32-byte private key
// and 32-byte public key concatenated (64 bytes); the shared secret is the raw 32-byte X25519 output. Reached only
// through the public key-agreement API.
enum x25519 {
    static func makeKeyPair() -> Data {
        let secret = Curve25519.KeyAgreement.PrivateKey()
        return secret.rawRepresentation + secret.publicKey.rawRepresentation
    }
    static func sharedSecret(_ privateKey: Data, _ publicKey: Data) -> Data {
        let secret = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
        let pub = try! Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
        let shared = try! secret.sharedSecretFromKeyAgreement(with: pub)
        return shared.withUnsafeBytes { Data($0) }
    }
}
