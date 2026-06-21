// Rune (Unicode code point) predicates and case mapping over swift's Unicode tables (Character / Unicode.Scalar). Each
// takes a code point and returns a boolean, or the mapped code point (unchanged when invalid or unmapped). Reached only
// through the public rune API.
import Foundation

enum rune {
    private static func char(_ code: Int) -> Character? {
        guard let scalar = Unicode.Scalar(UInt32(code)) else { return nil }
        return Character(scalar)
    }

    static func isLetter(_ code: Int) -> Bool { char(code)?.isLetter ?? false }
    static func isNumber(_ code: Int) -> Bool { char(code)?.isNumber ?? false }
    static func isWhitespace(_ code: Int) -> Bool { char(code)?.isWhitespace ?? false }
    static func isUppercase(_ code: Int) -> Bool { char(code)?.isUppercase ?? false }
    static func isLowercase(_ code: Int) -> Bool { char(code)?.isLowercase ?? false }
    static func isAlphanumeric(_ code: Int) -> Bool {
        let value = char(code)
        return (value?.isLetter ?? false) || (value?.isNumber ?? false)
    }
    static func isControl(_ code: Int) -> Bool {
        Unicode.Scalar(UInt32(code))?.properties.generalCategory == .control
    }
    static func toUppercase(_ code: Int) -> Int {
        guard let value = char(code),
              let scalar = value.uppercased().unicodeScalars.first
        else { return code }
        return Int(scalar.value)
    }
    static func toLowercase(_ code: Int) -> Int {
        guard let value = char(code),
              let scalar = value.lowercased().unicodeScalars.first
        else { return code }
        return Int(scalar.value)
    }
}
