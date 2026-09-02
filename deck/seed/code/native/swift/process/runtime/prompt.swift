// Line reading for the swift target, over Foundation's standard input. Reached only through the public
// process/line API.
//
// `readLine` is synchronous and there is no asynchronous stdin in Foundation, so the read runs on a detached task
// and the caller's task is not blocked. That is the honest shape: waiting for a person to type is not something
// the kernel can hand back sooner.
import Foundation

enum prompt {
  // the reader holds nothing on this backend (readLine owns the buffer), but the handle exists so the API is the
  // same one every other target has
  final class Tool: @unchecked Sendable {
    var open = true
  }

  static func lineOpen() async -> Tool {
    Tool()
  }

  static func lineAsk(_ tool: Tool, _ prompt: String) async -> String {
    FileHandle.standardOutput.write(Data(prompt.utf8))

    return await lineRead(tool)
  }

  // the line without its newline, or "" at the end of input
  static func lineRead(_ tool: Tool) async -> String {
    guard tool.open else { return "" }

    return await Task.detached { readLine(strippingNewline: true) ?? "" }.value
  }

  static func lineClose(_ tool: Tool) async {
    tool.open = false
  }
}
