// Locale runtime. Reached only through the public environment API. The identifier arrives in the POSIX form
// (`en_GB`), so it is normalised to a BCP 47 tag to match the other platforms.
import Foundation

enum tongue {
    static func tag() -> String {
        Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
    }

    static func timezone() -> String {
        TimeZone.current.identifier
    }

    static func preferred() -> [String] {
        Locale.preferredLanguages
    }
}
