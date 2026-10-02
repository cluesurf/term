import Foundation
import CryptoKit

// AES-256-GCM over CryptoKit. Key, nonce, plaintext, ciphertext and the additional authenticated data are raw bytes
// (Data). CryptoKit keeps the ciphertext and the 16-byte tag separate; the uniform interface concatenates them
// (ciphertext || tag) to match the other platforms, and splits them back apart on decrypt. Reached only through the
// public cipher API.
//
// `extra` is covered by the tag and is not part of the ciphertext, so a sealed value carries the context it was sealed
// in. `authenticating:` is CryptoKit's own parameter for it. Empty authenticates nothing, which is GCM's own default.
enum cipher {
    static func encrypt(_ key: Data, _ nonce: Data, _ plain: Data, _ extra: Data) -> Data {
        let symmetricKey = SymmetricKey(data: key)
        let gcmNonce = try! AES.GCM.Nonce(data: nonce)
        let sealed = try! AES.GCM.seal(plain, using: symmetricKey, nonce: gcmNonce, authenticating: extra)
        return sealed.ciphertext + sealed.tag
    }
    static func decrypt(_ key: Data, _ nonce: Data, _ sealed: Data, _ extra: Data) -> Data {
        let symmetricKey = SymmetricKey(data: key)
        let gcmNonce = try! AES.GCM.Nonce(data: nonce)
        let cipherText = sealed.prefix(sealed.count - 16)
        let tag = sealed.suffix(16)
        let box = try! AES.GCM.SealedBox(nonce: gcmNonce, ciphertext: cipherText, tag: tag)
        return try! AES.GCM.open(box, using: symmetricKey, authenticating: extra)
    }
}
