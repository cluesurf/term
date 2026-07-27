import Foundation
import CryptoKit

// Ed25519 signatures over CryptoKit. Keys, messages, and signatures are raw bytes (Data): a key-pair is the 32-byte
// private key and 32-byte public key concatenated (64 bytes); a signature is 64 bytes. Reached only through the public
// signature API.
enum eddsa {
    static func makeKeyPair() -> Data {
        let signing = Curve25519.Signing.PrivateKey()
        return signing.rawRepresentation + signing.publicKey.rawRepresentation
    }
    static func sign(_ privateKey: Data, _ message: Data) -> Data {
        let signing = try! Curve25519.Signing.PrivateKey(rawRepresentation: privateKey)
        return try! signing.signature(for: message)
    }
    static func verify(_ publicKey: Data, _ message: Data, _ signature: Data) -> Bool {
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else { return false }
        return key.isValidSignature(signature, for: message)
    }
}
