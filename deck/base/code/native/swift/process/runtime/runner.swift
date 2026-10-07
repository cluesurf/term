// Subprocess runner over Foundation.Process. Runs the command to completion, capturing stdout and stderr. A command
// that cannot start returns code -1 and the reason, which the public run API raises as `command-absence`. A bare name
// is found on PATH here, by `locate`: it went through /usr/bin/env, which answers a missing command as an exit of 127,
// so on Swift alone a typo read as a program that ran and failed. A child a signal ended answers code 128 plus the
// signal's number and `signal` that number (`terminationReason` is `.uncaughtSignal` and `terminationStatus` the
// number); one that exited by itself answers its code and signal 0. `directory` (empty is this process's own) and
// `environment` (entries added over the inherited one) shape the child, and a directory that is not there is a command
// that cannot start. Reached only through the public run API.
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

    // why a directory cannot hold a run, nil when it can (empty is this process's own)
    static func absent(_ directory: String) -> String? {
        if directory.isEmpty {
            return nil
        }
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directory, isDirectory: &isDirectory) && isDirectory.boolValue {
            return nil
        }
        return "\(directory): no such directory"
    }

    // the working directory and the added variables, set on a process that is about to run
    static func shape(_ process: Process, _ directory: String, _ environment: SeedMap<String, String>) {
        if !directory.isEmpty {
            process.currentDirectoryURL = URL(fileURLWithPath: directory)
        }
        if !environment.data.isEmpty {
            var merged = ProcessInfo.processInfo.environment
            for (name, value) in environment.data {
                merged[name] = value
            }
            process.environment = merged
        }
    }

    // the exit code a finished process answers and its signal: a signal death is 128 plus the signal
    static func finished(_ process: Process) -> (Int, Int) {
        let status = Int(process.terminationStatus)
        if process.terminationReason == .uncaughtSignal {
            return (128 + status, status)
        }
        return (status, 0)
    }

    static func run(_ command: String, _ argumentList: SeedList<String>, _ directory: String, _ environment: SeedMap<String, String>) async -> RunResult {
        if let reason = absent(directory) {
            return RunResult(code: -1, output: "", error: reason, signal: 0)
        }
        guard let executable = locate(command) else {
            return RunResult(code: -1, output: "", error: missing(command), signal: 0)
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = argumentList.data
        shape(process, directory, environment)
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe
        do {
            try process.run()
            let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
            let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let (code, signal) = finished(process)
            return RunResult(
                code: code,
                output: String(data: outData, encoding: .utf8) ?? "",
                error: String(data: errData, encoding: .utf8) ?? "",
                signal: signal
            )
        } catch {
            return RunResult(code: -1, output: "", error: String(describing: error), signal: 0)
        }
    }

    // the command on this terminal: no pipes, so it reads the keyboard and writes as it goes; its exit code (128 plus
    // the signal for a signal death), -1 when it could not start
    static func attached(_ command: String, _ argumentList: SeedList<String>, _ directory: String, _ environment: SeedMap<String, String>) async -> Int {
        if absent(directory) != nil {
            return -1
        }
        guard let executable = locate(command) else {
            return -1
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = argumentList.data
        shape(process, directory, environment)
        do {
            try process.run()
            process.waitUntilExit()
            return finished(process).0
        } catch {
            return -1
        }
    }

    // the command with `input` written to its standard input and then closed, its output captured as `run` captures it
    static func withInput(_ command: String, _ argumentList: SeedList<String>, _ input: String, _ directory: String, _ environment: SeedMap<String, String>) async -> RunResult {
        if let reason = absent(directory) {
            return RunResult(code: -1, output: "", error: reason, signal: 0)
        }
        guard let executable = locate(command) else {
            return RunResult(code: -1, output: "", error: missing(command), signal: 0)
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = argumentList.data
        shape(process, directory, environment)
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
            let (code, signal) = finished(process)
            return RunResult(
                code: code,
                output: String(data: outData, encoding: .utf8) ?? "",
                error: String(data: errData, encoding: .utf8) ?? "",
                signal: signal
            )
        } catch {
            return RunResult(code: -1, output: "", error: String(describing: error), signal: 0)
        }
    }
}
