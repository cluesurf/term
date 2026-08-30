import Foundation
import Dispatch

// Current-process runtime: ProcessInfo reads, exit, and a DispatchSource signal listener. The sources are
// retained for the life of the process (a released source stops delivering).
enum current {
    static var sources: [DispatchSourceSignal] = []

    static func processId() -> Int {
        Int(Foundation.ProcessInfo.processInfo.processIdentifier)
    }

    static func arguments() -> SeedList<String> {
        SeedList(Foundation.ProcessInfo.processInfo.arguments)
    }

    static func directory() -> String {
        FileManager.default.currentDirectoryPath
    }

    static func executable() -> String {
        Foundation.ProcessInfo.processInfo.arguments.first ?? ""
    }

    static func exit(_ code: Int) {
        Foundation.exit(Int32(code))
    }

    static func listen(_ signalId: Int, _ handler: @escaping () -> Void) {
        signal(Int32(signalId), SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: Int32(signalId), queue: .main)
        source.setEventHandler(handler: handler)
        source.resume()
        sources.append(source)
    }
}
