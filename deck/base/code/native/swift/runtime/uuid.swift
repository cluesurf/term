import Foundation

enum uuid {
    static func version4() -> String { return UUID().uuidString.lowercased() }
}
