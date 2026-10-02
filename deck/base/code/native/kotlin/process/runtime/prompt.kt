// Line reading for the kotlin target, over a buffered reader on standard input, run on `Dispatchers.IO`. The
// reader is held rather than rebuilt per call, because a BufferedReader keeps whatever it read past the newline:
// build a new one each time and the second line is the one the first read already swallowed.
//
// Reached only through the public process/line API.
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object prompt {
  class Tool(val reader: java.io.BufferedReader)

  suspend fun lineOpen(): Tool = withContext(Dispatchers.IO) {
    Tool(System.`in`.bufferedReader())
  }

  suspend fun lineAsk(tool: Tool, prompt: String): String {
    withContext(Dispatchers.IO) {
      print(prompt)
      System.out.flush()
    }

    return lineRead(tool)
  }

  // the line without its newline, or "" at the end of input
  suspend fun lineRead(tool: Tool): String = withContext(Dispatchers.IO) {
    try {
      tool.reader.readLine() ?: ""
    } catch (error: Exception) {
      ""
    }
  }

  // standard input is not ours to close: the tool is dropped, the descriptor stays as the process found it
  suspend fun lineClose(tool: Tool) {}
}
