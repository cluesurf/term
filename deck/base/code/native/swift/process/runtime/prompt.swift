// Line reading for the swift target, over Foundation's standard input. Reached only through the public
// process/line API.
//
// `readLine` is synchronous and there is no asynchronous stdin in Foundation, so the read runs on a detached task
// and the caller's task is not blocked. Waiting for a person to type is not something the kernel can hand back
// sooner.
//
// Once a read has met the end of input, every later read answers "" without reading again (item 1163), as on node,
// rust and kotlin and as process/line declares ("The empty text means the input ended"), whether or not the C
// library's end-of-file flag on stdin stays set.
import Foundation

enum prompt {
  // the reader holds nothing on this backend (readLine owns the buffer), but the handle exists so the API is the
  // same one every other target has
  final class Tool: @unchecked Sendable {
    var open = true
    // set once a read met the end
    var ended = false
  }

  static func lineOpen() async -> Tool {
    Tool()
  }

  static func lineAsk(_ tool: Tool, _ prompt: String) async -> String {
    FileHandle.standardOutput.write(Data(prompt.utf8))

    return await lineRead(tool)
  }

  // the line without its newline, or "" at the end of input and after it
  static func lineRead(_ tool: Tool) async -> String {
    guard tool.open, !tool.ended else { return "" }

    let line = await Task.detached { readLine(strippingNewline: true) }.value
    guard let line = line else {
      tool.ended = true
      return ""
    }

    return line
  }

  static func lineClose(_ tool: Tool) async {
    tool.open = false
  }
}
