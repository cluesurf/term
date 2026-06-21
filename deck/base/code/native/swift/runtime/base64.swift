import Foundation

enum base64 {
    static func encode(_ input: String) -> String { return Data(input.utf8).base64EncodedString() }
    static func decode(_ input: String) -> String {
        guard let d = Data(base64Encoded: input), let s = String(data: d, encoding: .utf8) else { return "" }
        return s
    }
}
