import { createInterface } from 'node:readline'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@cluesurf/make/code/compile/compile'
import type { Resolver } from '@cluesurf/make/code/compile/load'
import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'
import { stdlibResolver } from '@cluesurf/make/code/resolve'
import {
  logStep,
  logFail,
  logGood,
  fade,
  bold,
} from '@cluesurf/make/code/tint'

// the module resolvers now live in the compiler (make), so the CLI, dev server, and language server share them. Kept
// re-exported here for the CLI's existing call sites and tests.
export {
  stdlibResolver,
  linkResolver,
} from '@cluesurf/make/code/resolve'

// the keywords that begin a top-level definition; anything else typed at the prompt is an expression to evaluate
const DEFINITION =
  /^(task|form|load|mask|dock|suit|bear|deck|note|hold)\b/

export type FeedResult =
  | { kind: 'definition'; text: string }
  | { kind: 'value'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'empty' }

// A live Seed session: accumulate definitions, and evaluate an expression by wrapping it in a function, compiling the
// whole accumulated program with the real compiler, transpiling the emitted TypeScript to JS, importing it, and
// calling the wrapper. Free of terminal I/O, so it is unit-testable.
export class Repl {
  private readonly definitions: string[] = []

  constructor(private readonly resolve?: Resolver) {}

  async feed(block: string): Promise<FeedResult> {
    const trimmed = block.replace(/\s+$/, '')

    if (!trimmed.trim()) {return { kind: 'empty' }}

    if (DEFINITION.test(trimmed.trimStart())) {
      // a definition: accept it only if the program still compiles with it added
      const trial = [...this.definitions, trimmed].join('\n\n')
      const result = compile(
        { file: 'repl.tree', text: trial },
        { resolve: this.resolve },
      )

      if (!result.ok)
        {return {
          kind: 'error',
          text: formatDiagnostics(result.diagnostics),
        }}

      this.definitions.push(trimmed)

      const name = trimmed.trimStart().split(/\s+/)[1] ?? ''

      return { kind: 'definition', text: name }
    }

    // an expression: wrap it as `task seed-repl-eval / send back / <expr>` and run the wrapper
    const wrapped = `task seed-repl-eval\n  send back\n${trimmed
      .split('\n')
      .map(l => `    ${l}`)
      .join('\n')}`

    const full = [...this.definitions, wrapped].join('\n\n')
    const result = compile(
      { file: 'repl.tree', text: full },
      { resolve: this.resolve },
    )

    if (!result.ok)
      {return {
        kind: 'error',
        text: formatDiagnostics(result.diagnostics),
      }}

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
  if (typeof value === 'string') {return JSON.stringify(value)}

  if (value && typeof value === 'object') {return JSON.stringify(value)}

  return String(value)
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics.map(d => `${d.name}: ${d.message}`).join('\n')
}

export async function callWalk(_input: {
  root: string
}): Promise<void> {
  logStep('Seed REPL')
  console.log(
    fade(
      '  Type a definition (task / form / load) to add it, an expression to evaluate it, or `exit`.',
    ),
  )
  console.log(fade('  Finish a multi-line block with a blank line.\n'))

  const repl = new Repl(stdlibResolver())
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: bold('seed> '),
  })

  let buffer: string[] = []

  const flush = async (): Promise<void> => {
    const block = buffer.join('\n')
    buffer = []

    if (!block.trim()) {return}

    const result = await repl.feed(block)

    if (result.kind === 'value') {console.log(result.text)}
    else if (result.kind === 'definition')
      {console.log(fade(`  added ${result.text}`))}
    else if (result.kind === 'error') {logFail(result.text)}
  }

  rl.prompt()
  rl.on('line', async line => {
    if (line.trim() === 'exit') {return rl.close()}

    if (line.trim() === '') {
      await flush()
      rl.prompt()

      return
    }

    buffer.push(line)

    // a single-line expression evaluates immediately; an indented block waits for a blank line
    if (buffer.length === 1 && !DEFINITION.test(line.trimStart()))
      {await flush()}

    rl.prompt()
  })
  rl.on('close', () => {
    logGood('bye')
    process.exit(0)
  })
}
