import { createInterface } from 'node:readline'
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '../compile/compile'
import type { Resolver, Source } from '../compile/load'
import type { Diagnostic } from '../parser/diagnostic'
import { logStep, logFail, logGood, fade, bold } from '../tint'

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
  private readonly definitions: Array<string> = []

  constructor(private readonly resolve?: Resolver) {}

  async feed(block: string): Promise<FeedResult> {
    const trimmed = block.replace(/\s+$/, '')
    if (!trimmed.trim()) return { kind: 'empty' }

    if (DEFINITION.test(trimmed.trimStart())) {
      // a definition: accept it only if the program still compiles with it added
      const trial = [...this.definitions, trimmed].join('\n\n')
      const result = compile(
        { file: 'repl.tree', text: trial },
        { resolve: this.resolve },
      )
      if (!result.ok)
        return {
          kind: 'error',
          text: formatDiagnostics(result.diagnostics),
        }
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
      return {
        kind: 'error',
        text: formatDiagnostics(result.diagnostics),
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
  if (typeof value === 'string') return JSON.stringify(value)
  if (value && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function formatDiagnostics(diagnostics: Array<Diagnostic>): string {
  return diagnostics.map(d => `${d.name}: ${d.message}`).join('\n')
}

// resolve `@cluesurf/base/...` imports to the stdlib that ships with this package, if it can be found on disk
export function stdlibResolver(): Resolver | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', '..', '..', 'base.tree'),
    join(here, '..', '..', 'base.tree'),
  ]
  const base = candidates.find(c => existsSync(c))
  if (!base) return undefined
  return (path: string): Source | undefined => {
    const prefix = '@cluesurf/base/'
    if (!path.startsWith(prefix)) return undefined
    const file = join(base, `${path.slice(prefix.length)}.tree`)
    return existsSync(file)
      ? { file, text: readFileSync(file, 'utf8') }
      : undefined
  }
}

// the stdlib base.tree directory, located the same way stdlibResolver does (dev tree or installed). Used to read the
// raw native runtime files (`.ts`/`.js` under `code/native/...`) that `nativePrelude` inlines when running a module.
export function stdlibBase(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    join(here, '..', '..', '..', 'base.tree'),
    join(here, '..', '..', 'base.tree'),
  ].find(c => existsSync(c))
}

// a reader for native runtime sources, given a `@cluesurf/base/<path>` reference. Unlike the resolver, this reads the
// raw file (no `.tree` suffix), since runtime files are native code, not Seed.
export function stdlibRuntime(): (path: string) => string | undefined {
  const base = stdlibBase()
  return (path: string): string | undefined => {
    const prefix = '@cluesurf/base/'
    if (!base || !path.startsWith(prefix)) return undefined
    const file = join(base, path.slice(prefix.length))
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }
}

// resolve any `@scope/pkg/sub/path` import via the package manager's link dir (`<root>/link/@scope/pkg/...`), where
// `seed link` symlinks each dependency. Follows the file-resolution rules (foo.tree, then foo/base.tree, foo/note.tree).
// This is how a project resolves its linked packages (@cluesurf/base, @cluesurf/bind, @cluesurf/term, @cluesurf/site).
export function linkResolver(root: string): Resolver {
  const linkDir = join(root, 'link')
  return (importPath: string): Source | undefined => {
    const match = importPath.match(/^(@[^/]+\/[^/]+)\/(.+)$/)
    if (!match) return undefined
    const [, pkg, rest] = match
    const base = join(linkDir, pkg!)
    for (const candidate of [
      join(base, `${rest}.tree`),
      join(base, rest!, 'base.tree'),
      join(base, rest!, 'note.tree'),
    ]) {
      // canonicalize through the `link/` symlink so a file reached via a linked package and via its real path dedup
      // to one module (lets a package reference itself by name, e.g. `bear @cluesurf/site/code/dom/view`)
      if (existsSync(candidate))
        return {
          file: realpathSync(candidate),
          text: readFileSync(candidate, 'utf8'),
        }
    }
    return undefined
  }
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
  let buffer: Array<string> = []

  const flush = async (): Promise<void> => {
    const block = buffer.join('\n')
    buffer = []
    if (!block.trim()) return
    const result = await repl.feed(block)
    if (result.kind === 'value') console.log(result.text)
    else if (result.kind === 'definition')
      console.log(fade(`  added ${result.text}`))
    else if (result.kind === 'error') logFail(result.text)
  }

  rl.prompt()
  rl.on('line', async line => {
    if (line.trim() === 'exit') return rl.close()
    if (line.trim() === '') {
      await flush()
      rl.prompt()
      return
    }
    buffer.push(line)
    // a single-line expression evaluates immediately; an indented block waits for a blank line
    if (buffer.length === 1 && !DEFINITION.test(line.trimStart()))
      await flush()
    rl.prompt()
  })
  rl.on('close', () => {
    logGood('bye')
    process.exit(0)
  })
}
