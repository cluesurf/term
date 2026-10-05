// The solver binding on Swift: SMT-LIB2 text in, Z3's answer out, through a `z3 -in` process per script. The node
// binding (smt-text.ts) keeps one Z3 context, and this keeps none, which is why smt-query.tree sends each question as
// one self-contained script, the model asked for in the same text. `TERM_Z3` names the binary, else `z3` on the path.
import Foundation

enum smtText {
    static func evaluate(_ text: String) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [ProcessInfo.processInfo.environment["TERM_Z3"] ?? "z3", "-in"]

        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return "unknown"
        }

        input.fileHandleForWriting.write((text + "\n(exit)\n").data(using: .utf8)!)
        try? input.fileHandleForWriting.close()

        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        return String(decoding: data, as: UTF8.self)
    }
}
