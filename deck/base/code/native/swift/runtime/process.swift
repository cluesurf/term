import Foundation

enum process {
    static func getPlatform() -> String { return Foundation.ProcessInfo.processInfo.operatingSystemVersionString }
    static func exitWith(_ code: Int) { exit(Int32(code)) }
}
