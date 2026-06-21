import Foundation

enum hex {
    static func encode(_ input: String) -> String { return Data(input.utf8).map { String(format: "%02x", $0) }.joined() }
    static func decode(_ input: String) -> String {
        var bytes = [UInt8]()
        var i = input.startIndex
        while i < input.endIndex, let j = input.index(i, offsetBy: 2, limitedBy: input.endIndex) {
            if let b = UInt8(input[i..<j], radix: 16) { bytes.append(b) }
            i = j
        }
        return String(bytes: bytes, encoding: .utf8) ?? ""
    }
}
