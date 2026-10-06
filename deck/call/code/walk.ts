import { createInterface } from 'node:readline'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import type { Resolver } from '@term/make/code/compile/load'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { closeRun, failRun, field, openRun, printData, report } from '@term/call/code/output'
import { projectResolver } from '@term/call/code/make'

// the module resolvers now live in the compiler (make), so the CLI, dev server, and language server share them. Kept
// re-exported here for the CLI's existing call sites and tests.
export {
  stdlibResolver,
  linkResolver,
  siblingResolver,
} from '@term/make/code/resolve'
import * as port from '@term/call/code/repl-read'

// HOW A BLOCK IS READ is Term since 2026-10-06, call/code/repl-read.tree: which heads open a definition (read with the
// parser, never matched: a line that does not parse is not a definition rather than an error), the trimming, the
// definition's name and the task an expression is wrapped in. This file compiles, runs and prints.

export type FeedResult =
  | { kind: 'definition'; text: string }
  | { kind: 'value'; text: string }
  // `diagnostics` when the compiler refused it, each drawn as its own Problem item
  | { kind: 'error'; text: string; diagnostics?: Diagnostic[] }
  | { kind: 'empty' }

// A live Seed session: accumulate definitions, and evaluate an expression by wrapping it in a function, compiling the
// whole accumulated program with the real compiler, transpiling the emitted TypeScript to JS, importing it, and
// calling the wrapper. Free of terminal I/O, so it is unit-testable.
export class Repl {
  private readonly definitions: string[] = []

  // `file` is where the session's text is taken to live, so a relative `load` resolves from the project folder
  constructor(
    private readonly resolve?: Resolver,
    private readonly file = 'repl.tree',
  ) {}

  async feed(block: string): Promise<FeedResult> {
    const read = port.readBlock(block)

    if (read.form === 'empty') {
      return { kind: 'empty' }
    }

    if (read.form === 'definition') {
      const trimmed = read.text

      // a definition: accept it only if the program still compiles with it added
      const trial = [...this.definitions, trimmed].join('\n\n')
      const result = compile(
        { file: this.file, text: trial },
        { resolve: this.resolve },
      )

      if (!result.ok) {
        return {
          kind: 'error',
          text: formatDiagnostics(result.diagnostics),
          diagnostics: result.diagnostics,
        }
      }

      const name = read.name

      // a `load` of a path nothing answers is refused, not `added`: it was accepted, and the first call to a name it
      // was to bring failed as an unknown name
      if (port.trimStart(trimmed).startsWith('load ') && this.resolve && !this.resolve(name, this.file)) {
        return { kind: 'error', text: `nothing answers load ${name}` }
      }

      this.definitions.push(trimmed)

      return { kind: 'definition', text: name }
    }

    // an expression: wrapped as `task seed-repl-eval / send back / <expr>`, and the wrapper run
    const full = [...this.definitions, read.wrapped].join('\n\n')
    const result = compile(
      { file: this.file, text: full },
      { resolve: this.resolve },
    )

    if (!result.ok) {
      return {
        kind: 'error',
        text: formatDiagnostics(result.diagnostics),
        diagnostics: result.diagnostics,
      }
    }

    try {
      const value = await run(result.typescript)

      return { kind: 'value', text: display(value) }
    } catch (error) {
      return {
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

// transpile the emitted TypeScript to an ES module, import it, and return the value of the eval wrapper
async function run(typescript: string): Promise<unknown> {
  const js = transformSync(typescript, {
    loader: 'ts',
    format: 'esm',
  }).code

  const dir = mkdtempSync(join(tmpdir(), 'seed-repl-'))
  const file = join(dir, 'repl.mjs')
  writeFileSync(file, js)

  const module = (await import(pathToFileURL(file).href)) as {
    seedReplEval?: () => unknown
  }

  return module.seedReplEval ? module.seedReplEval() : undefined
}

// a runtime value to a readable line
function display(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (value && typeof value === 'object') {
    return JSON.stringify(value)
  }

  return String(value)
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics.map(d => `${d.name}: ${d.message}`).join('\n')
}

// THE SESSION IS AN INTERACTION, so its dialog is data on stdout: the prompt, each value, `added <name>` for a
// definition, and `bye`, exactly as typed and answered. Around it the run is items on stderr: the opening with how to
// use it, a ✗ Problem item per input that did not compile or threw, and the closing item
export async function callWalk(input: {
  root: string
}): Promise<void> {
  openRun({ verb: 'walk', root: input.root, subject: 'Term REPL' })
  report({
    glyph: 'info',
    verb: 'walk',
    subject: 'Type a definition to add it, an expression to evaluate it, or exit',
    message: ['A definition is task, form or load. Finish a multi-line block with a blank line.'],
  })

  // the project the session was started in, as `term make` resolves it: its own files by a relative path and its
  // linked decks as well as the standard library. It saw the standard library alone, so `load ./code/count` printed
  // `added` and the next call to a name from it failed as `unknown-name` (guides: commands/walk, 2026-10-04)
  const repl = new Repl(projectResolver(input.root, 'node', input.root), join(input.root, 'repl.tree'))
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'term> ',
  })

  let buffer: string[] = []

  const flush = async (): Promise<void> => {
    const block = buffer.join('\n')
    buffer = []

    if (port.isBlank(block)) {
      return
    }

    const result = await repl.feed(block)

    if (result.kind === 'value') {
      printData(`${result.text}\n`)
    } else if (result.kind === 'definition') {
      printData(`added ${result.text}\n`)
    } else if (result.kind === 'error' && result.diagnostics?.length) {
      // the message is the subject and the name a fact (section 12); the session's text is not a file, so no `at`
      for (const diagnostic of result.diagnostics) {
        const [first = '', ...rest] = diagnostic.message.split('\n')
        report({ glyph: diagnostic.severity === 'warning' ? 'warning' : 'failed', kind: 'problem', verb: 'check', subject: first.charAt(0).toUpperCase() + first.slice(1), facts: [diagnostic.name], message: rest, fields: diagnostic.hint ? [field('next', diagnostic.hint)] : [] })
      }
    } else if (result.kind === 'error') {
      report({ glyph: 'failed', kind: 'problem', verb: 'run', subject: result.text.charAt(0).toUpperCase() + result.text.slice(1) })
    }
  }

  // READLINE DOES NOT AWAIT AN ASYNC `line` LISTENER. Typing, that is invisible: a person is slower than a compile,
  // so each line finishes long before the next arrives. PIPED, every queued line fires back to back and `close`
  // follows immediately, and a `close` that called `process.exit` killed every flush still in flight. So
  // `term walk < script.tree` printed the banner, the prompt and `bye`, and evaluated nothing at all.
  //
  // Chaining the work makes the order the input's order either way, and `close` waits for the chain to drain
  // before saying goodbye. A pasted block is the same case as a pipe, so this is not only about scripts.
  let work: Promise<void> = Promise.resolve()

  const queue = (job: () => Promise<void>): void => {
    work = work.then(job)
  }

  // Once the interface is closed, `prompt` throws (`readline was closed`, Node's ERR_USE_AFTER_CLOSE). A closed
  // interface is normal here: `exit`, or piped input ending while a definition is still compiling. Track it and
  // prompt only while it is open, so a queued job finishing late does not fail the REPL on its way out
  let closed = false

  rl.on('close', () => {
    closed = true
  })

  const promptAgain = (): void => {
    if (!closed) {
      rl.prompt()
    }
  }

  rl.prompt()
  rl.on('line', line => {
    if (line.trim() === 'exit') {
      rl.close()

      return
    }

    // THE WHOLE STEP GOES IN THE QUEUE, the buffer push included. Deciding here and flushing later is not enough:
    // the listener runs for every piped line before a single queued job does, so the buffer held the entire input
    // by the time the first flush looked at it, and a definition swallowed the calls that came after it.
    queue(async () => {
      if (port.isBlank(line)) {
        await flush()
      } else {
        buffer.push(line)

        // a single-line expression evaluates immediately; an indented block waits for a blank line
        if (buffer.length === 1 && !port.isDefinition(port.trimStart(line))) {
          await flush()
        }
      }

      promptAgain()
    })
  })
  rl.on('close', () => {
    // whatever is still evaluating gets to finish and print. An input that ended without a blank line still has a
    // block in the buffer, and dropping it silently would be the same class of bug as exiting early.
    void work
      .then(flush)
      .catch(error => {
        report({ glyph: 'failed', kind: 'problem', subject: String((error as Error).message ?? error) })
      })
      .then(() => {
        printData('bye\n')
        process.exit(closeRun({ verdict: 'Session ended' }))
      })
      .catch(error => {
        process.exit(failRun(error, input.root))
      })
  })
}
