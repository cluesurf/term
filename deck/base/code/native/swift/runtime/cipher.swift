import Foundation
import CryptoKit

// AES-256-GCM over CryptoKit. CryptoKit keeps the ciphertext and the 16-byte tag separate; the uniform interface
// concatenates them (ciphertext || tag) to match the other platforms, and splits them back apart on decrypt.
enum cipher {
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
    static func encrypt(_ keyHex: String, _ nonceHex: String, _ plain: String) -> String {
        let key = SymmetricKey(data: fromHex(keyHex))
        let nonce = try! AES.GCM.Nonce(data: fromHex(nonceHex))
        let sealed = try! AES.GCM.seal(Data(plain.utf8), using: key, nonce: nonce)
        return toHex(sealed.ciphertext + sealed.tag)
    }
    static func decrypt(_ keyHex: String, _ nonceHex: String, _ cipherHex: String) -> String {
        let key = SymmetricKey(data: fromHex(keyHex))
        let combined = fromHex(cipherHex)
        let nonce = try! AES.GCM.Nonce(data: fromHex(nonceHex))
        let cipherText = combined.prefix(combined.count - 16)
        let tag = combined.suffix(16)
        let box = try! AES.GCM.SealedBox(nonce: nonce, ciphertext: cipherText, tag: tag)
        return String(data: try! AES.GCM.open(box, using: key), encoding: .utf8)!
    }
}
