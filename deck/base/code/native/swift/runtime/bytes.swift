import Foundation

// Raw byte buffers over swift. The currency value is Foundation Data.
enum bytes {
    static func fromText(_ text: String) -> Data { return Data(text.utf8) }
    static func toText(_ value: Data) -> String { return String(data: value, encoding: .utf8) ?? "" }
    static func toHex(_ value: Data) -> String { return value.map { String(format: "%02x", $0) }.joined() }
    static func fromHex(_ text: String) -> Data {
        var data = Data(capacity: text.count / 2)
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            data.append(UInt8(text[index..<next], radix: 16) ?? 0)
            index = next
        }
        return data
    }
    static func toBase64(_ value: Data) -> String { return value.base64EncodedString() }
    static func fromBase64(_ text: String) -> Data { return Data(base64Encoded: text) ?? Data() }
    static func length(_ value: Data) -> Int { return value.count }
    static func concat(_ left: Data, _ right: Data) -> Data { return left + right }
    static func slice(_ value: Data, _ start: Int, _ end: Int) -> Data { return value.subdata(in: start..<end) }
}
