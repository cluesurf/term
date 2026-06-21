import Foundation
import CryptoKit

// AES-256-GCM over CryptoKit. Key, nonce, plaintext, and ciphertext are raw bytes (Data). CryptoKit keeps the
// ciphertext and the 16-byte tag separate; the uniform interface concatenates them (ciphertext || tag) to match the
// other platforms, and splits them back apart on decrypt. Reached only through the public cipher API.
enum cipher {
    static func encrypt(_ key: Data, _ nonce: Data, _ plain: Data) -> Data {
        let symmetricKey = SymmetricKey(data: key)
        let gcmNonce = try! AES.GCM.Nonce(data: nonce)
        let sealed = try! AES.GCM.seal(plain, using: symmetricKey, nonce: gcmNonce)
        return sealed.ciphertext + sealed.tag
    }
    static func decrypt(_ key: Data, _ nonce: Data, _ sealed: Data) -> Data {
        let symmetricKey = SymmetricKey(data: key)
        let gcmNonce = try! AES.GCM.Nonce(data: nonce)
        let cipherText = sealed.prefix(sealed.count - 16)
        let tag = sealed.suffix(16)
        let box = try! AES.GCM.SealedBox(nonce: gcmNonce, ciphertext: cipherText, tag: tag)
        return try! AES.GCM.open(box, using: symmetricKey)
    }
}
