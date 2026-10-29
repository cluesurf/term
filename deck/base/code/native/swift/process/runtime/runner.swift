// Subprocess runner over Foundation.Process. Runs the command to completion, capturing stdout and stderr, read at the
// same time on two threads so a child filling one pipe never waits on the other. A command that cannot start returns
// code -1 and the reason, which the public run API raises as `command-absence`. A bare name is found on PATH here, by
// `locate`: it went through /usr/bin/env, which answers a missing command as an exit of 127, so on Swift alone a typo
// read as a program that ran and failed. A child a signal ended answers code 128 plus the signal's number and `signal`
// that number (`terminationReason` is `.uncaughtSignal` and `terminationStatus` the number); one that exited by itself
// answers its code and signal 0. `directory` (empty is this process's own) and `environment` (entries added over the
// inherited one) shape the child, and a directory that is not there is a command that cannot start. `limit`
// (milliseconds, 0 or below none) ends the child at the limit with `terminate()` (TERM), then KILL 2000 ms later, and
// answers code -2 with what it wrote once both pipes closed, or 500 ms after the exit (a grandchild may hold a pipe).
// Reached only through the public run API.
import Foundation

enum runner {
    // bytes one reader thread appends and the runner reads, behind a lock
    final class Held {
        private let lock = NSLock()
        private var bytes = Data()
        private var ended = false

        func add(_ more: Data) {
            lock.lock()
            bytes.append(more)
            lock.unlock()
        }

        func end() {
            lock.lock()
            ended = true
            lock.unlock()
        }

        var done: Bool {
            lock.lock()
            defer { lock.unlock() }
            return ended
        }

        var text: String {
            lock.lock()
            defer { lock.unlock() }
            return String(data: bytes, encoding: .utf8) ?? ""
        }
    }

    // a pipe read to its end on a thread of its own
    static func reading(_ pipe: Pipe) -> Held {
        let held = Held()
        let handle = pipe.fileHandleForReading
        Thread.detachNewThread {
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty {
                    break
                }
                held.add(chunk)
            }
            held.end()
        }
        return held
    }

    // whether the limit fired, set from the timer's queue and read by the runner
    final class Fired {
        private let lock = NSLock()
        private var value = false

        func set() {
            lock.lock()
            value = true
            lock.unlock()
        }

        var isSet: Bool {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
    }

    // TERM at the limit and KILL 2000 ms later, for a process still running then
    static func limiting(_ process: Process, _ limit: Int) -> Fired {
        let fired = Fired()
        if limit > 0 {
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(limit)) {
                if process.isRunning {
                    fired.set()
                    process.terminate()
                    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(2000)) {
                        if process.isRunning {
                            kill(process.processIdentifier, SIGKILL)
                        }
                    }
                }
            }
        }
        return fired
    }

    // wait for both readers: to their end, or under a limit at most 500 ms
    static func drain(_ output: Held, _ error: Held, _ limit: Int) {
        let start = Date()
        while !(output.done && error.done) {
            if limit > 0 && Date().timeIntervalSince(start) >= 0.5 {
                return
            }
            Thread.sleep(forTimeInterval: 0.005)
        }
    }

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

    // a captured run: both pipes read at once, the child waited (and ended at the limit), the answer taken once the
    // readers are done or, under a limit, 500 ms after the exit
    static func captured(_ process: Process, _ input: String?, _ limit: Int) -> RunResult {
        let inPipe = Pipe()
        let outPipe = Pipe()
        let errPipe = Pipe()
        if input != nil {
            process.standardInput = inPipe
        }
        process.standardOutput = outPipe
        process.standardError = errPipe
        do {
            try process.run()
            let output = reading(outPipe)
            let error = reading(errPipe)
            let fired = limiting(process, limit)
            if let text = input {
                inPipe.fileHandleForWriting.write(text.data(using: .utf8) ?? Data())
                try? inPipe.fileHandleForWriting.close()
            }
            process.waitUntilExit()
            drain(output, error, limit)
            if fired.isSet {
                return RunResult(code: -2, output: output.text, error: error.text, signal: 0)
            }
            let (code, signal) = finished(process)
            return RunResult(code: code, output: output.text, error: error.text, signal: signal)
        } catch {
            return RunResult(code: -1, output: "", error: String(describing: error), signal: 0)
        }
    }

    static func run(_ command: String, _ argumentList: SeedList<String>, _ directory: String, _ environment: SeedMap<String, String>, _ limit: Int) async -> RunResult {
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
        return captured(process, nil, limit)
    }

    // the command on this terminal: no pipes, so it reads the keyboard and writes as it goes; its exit code (128 plus
    // the signal for a signal death), -1 when it could not start, -2 when its limit ended it
    static func attached(_ command: String, _ argumentList: SeedList<String>, _ directory: String, _ environment: SeedMap<String, String>, _ limit: Int) async -> Int {
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
            let fired = limiting(process, limit)
            process.waitUntilExit()
            return fired.isSet ? -2 : finished(process).0
        } catch {
            return -1
        }
    }

    // the command with `input` written to its standard input and then closed, its output captured as `run` captures it
    static func withInput(_ command: String, _ argumentList: SeedList<String>, _ input: String, _ directory: String, _ environment: SeedMap<String, String>, _ limit: Int) async -> RunResult {
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
        return captured(process, input, limit)
    }
}
