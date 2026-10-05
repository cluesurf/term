// Subprocess runner over Foundation.Process. Runs the command to completion, capturing stdout and stderr. A command
// that cannot start returns code -1 and the reason, which the public run API raises as `command-absence`. A bare name
// is found on PATH here, by `locate`: it went through /usr/bin/env, which answers a missing command as an exit of 127,
// so on Swift alone a typo read as a program that ran and failed. Reached only through the public run API.
import Foundation

enum runner {
    // the executable a command names: a path as written, or the first directory on PATH that holds it
    static func locate(_ command: String) -> URL? {
        let files = FileManager.default
        if command.contains("/") {
            return files.isExecutableFile(atPath: command) ? URL(fileURLWithPath: command) : nil
        }
        let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
        for directory in path.split(separator: ":") {
            let candidate = "\(directory)/\(command)"
            if files.isExecutableFile(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
        }
        return nil
    }

    static func missing(_ command: String) -> String {
        return "\(command): no such command on PATH"
    }

    static func run(_ command: String, _ argumentList: SeedList<String>) async -> RunResult {
        guard let executable = locate(command) else {
            return RunResult(code: -1, output: "", error: missing(command))
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = argumentList.data
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        do {
            try process.run()
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

    // the command on this terminal: no pipes, so it reads the keyboard and writes as it goes; its exit code, -1 when it
    // could not start
    static func attached(_ command: String, _ argumentList: SeedList<String>) async -> Int {
        guard let executable = locate(command) else {
            return -1
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = argumentList.data
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
        guard let executable = locate(command) else {
            return RunResult(code: -1, output: "", error: missing(command))
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = argumentList.data
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
