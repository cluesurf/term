// Line reading for the kotlin target, over a buffered reader on standard input, each blocking read HANDED BACK to the
// runtime's pool (`termLoop.handBack`, note/project/term/decision/001-native-work-hands-back-to-the-loop.md), so the
// waiting coroutine resumes on the loop. No kotlinx. The reader is held rather than rebuilt per call, because a
// BufferedReader keeps whatever it read past the newline: build a new one each time and the second line is the one
// the first read already swallowed.
//
// Once a read has met the end of input (or an error), every later read answers "" without reading again (item 1163),
// as on node, rust and swift and as process/line declares ("The empty text means the input ended"). A terminal after
// Ctrl-D, or a FIFO a second writer opens, would otherwise give more lines after the end.
//
// Reached only through the public process/line API.

object prompt {
  class Tool(val reader: java.io.BufferedReader) {
    // set on the loop once a read met the end
    var ended = false
  }

  suspend fun lineOpen(): Tool = termLoop.handBack {
    Tool(System.`in`.bufferedReader())
  }

  suspend fun lineAsk(tool: Tool, prompt: String): String {
    termLoop.handBack {
      kotlin.io.print(prompt)
      System.out.flush()
    }

    return lineRead(tool)
  }

  // the line without its newline, or "" at the end of input and after it
  suspend fun lineRead(tool: Tool): String {
    if (tool.ended) {
      return ""
    }

    val line: String? = termLoop.handBack {
      try {
        tool.reader.readLine()
      } catch (error: kotlin.Exception) {
        null
      }
    }

    if (line == null) {
      tool.ended = true
      return ""
    }

    return line
  }

  // standard input is not ours to close: the tool is dropped, the descriptor stays as the process found it
  suspend fun lineClose(tool: Tool) {}
}
