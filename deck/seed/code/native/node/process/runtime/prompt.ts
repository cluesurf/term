// Line reading for node, over node:readline. The interface is held rather than rebuilt per call: a readline
// interface takes the terminal, and two of them over one stdin fight for the keystrokes.
//
// Reached only through the public process/line API.
import * as readline from 'node:readline'

const prompt = {
  lineOpen: async (): Promise<readline.Interface> =>
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    }),

  lineAsk: async (
    tool: readline.Interface,
    text: string,
  ): Promise<string> =>
    new Promise(answer => {
      tool.question(text, line => answer(line))
    }),

  // the next line, or '' at the end of input
  lineRead: async (tool: readline.Interface): Promise<string> =>
    new Promise(answer => {
      const done = (line?: string): void => {
        tool.off('line', onLine)
        tool.off('close', onClose)
        answer(line ?? '')
      }
      const onLine = (line: string): void => done(line)
      const onClose = (): void => done()

      tool.once('line', onLine)
      tool.once('close', onClose)
    }),

  lineClose: async (tool: readline.Interface): Promise<void> => {
    tool.close()
  },
}
