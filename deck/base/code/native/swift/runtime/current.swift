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
        // the program's own arguments, as on every backend: the first is the program
        SeedList(Array(Foundation.ProcessInfo.processInfo.arguments.dropFirst()))
    }

    static func directory() -> String {
        FileManager.default.currentDirectoryPath
    }

    static func executable() -> String {
        Foundation.ProcessInfo.processInfo.arguments.first ?? ""
    }

    // the executable with every link followed, the empty text when it cannot be read. The path is Foundation's
    // (_NSGetExecutablePath on Darwin, /proc/self/exe on Linux), not `executable`'s first argument, which is a bare
    // name when the program was found on PATH, and realpath would read that against the working directory
    static func programFile() -> String {
        guard let path = Bundle.main.executablePath, let resolved = realpath(path, nil) else { return "" }
        defer { free(resolved) }

        return String(cString: resolved)
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
