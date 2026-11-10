// Line reading for node, over node:readline. The interface is held rather than rebuilt per call: a readline
// interface takes the terminal, and two of them over one stdin fight for the keystrokes.
//
// The tool listens for every line from the moment it opens and queues each one until a read takes it (item 1161).
// readline emits all the lines of one chunk of input at once, so a listener added per read lost the second line of a
// chunk, and a read made after readline closed waited for a 'close' that had already passed. Now a read answers a
// queued line first, then the empty text once the input has ended, as the rust, swift and kotlin readers do.
//
// Reached only through the public process/line API.
import * as readline from 'node:readline'

type Tool = {
  face: readline.Interface
  // lines that arrived before a read asked for them, oldest first
  lines: Array<string>
  // whoever waits for the next line, answered with '' at the end of input
  waiting: Array<(line: string) => void>
  ended: boolean
}

const prompt = {
  lineOpen: async (): Promise<Tool> => {
    const face = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    const tool: Tool = { face, lines: [], waiting: [], ended: false }

    face.on('line', line => {
      const next = tool.waiting.shift()
      if (next) {
        next(line)
      } else {
        tool.lines.push(line)
      }
    })
    face.on('close', () => {
      tool.ended = true
      for (const next of tool.waiting.splice(0)) {
        next('')
      }
    })

    return tool
  },

  // write `text`, then the next line. readline's question writes the prompt so that line editing redraws it, and
  // its answer bypasses the 'line' event, so it is used only while nothing is queued and the input is open
  lineAsk: async (tool: Tool, text: string): Promise<string> => {
    if (tool.lines.length > 0 || tool.ended) {
      process.stdout.write(text)
      return prompt.lineRead(tool)
    }

    return new Promise(answer => {
      tool.waiting.push(answer)
      tool.face.question(text, line => {
        const at = tool.waiting.indexOf(answer)
        if (at !== -1) {
          tool.waiting.splice(at, 1)
        }
        answer(line)
      })
    })
  },

  // the next line, or '' at the end of input
  lineRead: async (tool: Tool): Promise<string> => {
    const line = tool.lines.shift()
    if (line !== undefined) {
      return line
    }
    if (tool.ended) {
      return ''
    }

    return new Promise(answer => {
      tool.waiting.push(answer)
    })
  },

  lineClose: async (tool: Tool): Promise<void> => {
    tool.face.close()
  },
}
