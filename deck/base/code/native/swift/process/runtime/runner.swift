// Subprocess runner over Foundation.Process. Runs the command to completion via /usr/bin/env (so a bare command name
// is resolved on PATH), capturing stdout and stderr. A failure returns code -1 and the error text, so the public run
// API stays total. Reached only through the public run API.
import Foundation

enum runner {
    static func run(_ command: String, _ argumentList: SeedList<String>) async -> RunResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [command] + argumentList.data
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        do {
            try process.run()
            process.waitUntilExit()
            let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
            let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            return RunResult(
                code: Int(process.terminationStatus),
                output: String(data: outData, encoding: .utf8) ?? "",
                error: String(data: errData, encoding: .utf8) ?? ""
            )
        } catch {
            return RunResult(code: -1, output: "", error: String(describing: error))
        }
    }

    // the command on this terminal: no pipes, so it reads the keyboard and writes as it goes; its exit code, -1 when it
    // could not start
    static func attached(_ command: String, _ argumentList: SeedList<String>) async -> Int {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [command] + argumentList.data
        do {
            try process.run()
            process.waitUntilExit()
            return Int(process.terminationStatus)
        } catch {
            return -1
        }
    }

    // the command with `input` written to its standard input and then closed, its output captured as `run` captures it
    static func withInput(_ command: String, _ argumentList: SeedList<String>, _ input: String) async -> RunResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [command] + argumentList.data
        let inPipe = Pipe()
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardInput = inPipe
        process.standardOutput = outPipe
        process.standardError = errPipe
        do {
            try process.run()
            inPipe.fileHandleForWriting.write(input.data(using: .utf8) ?? Data())
            try? inPipe.fileHandleForWriting.close()
            let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
            let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return RunResult(
                code: Int(process.terminationStatus),
                output: String(data: outData, encoding: .utf8) ?? "",
                error: String(data: errData, encoding: .utf8) ?? ""
            )
        } catch {
            return RunResult(code: -1, output: "", error: String(describing: error))
        }
    }
}
