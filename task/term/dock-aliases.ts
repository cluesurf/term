// Dock aliases that name two different modules inside ONE port's load closure. A port inlines its whole load closure
// with ONE `import * as __dock_<alias>` per alias name, so the first dock read wins and every call through the other
// reads a member of the wrong module: it compiles clean, the probe build passes, and the first call throws 'is not a
// function' (traps.md of note/project/term/cli-in-term, term-cli-in-term-0066: make.tree's make-native dock and the
// boot and bundle ports' compile/native were both `native-module`, and `term make --env` died exit 70).
//
// Every `.tree` under deck/call/code is a port. Its closure is the file and every `.tree` its `load` lines reach,
// transitively (a relative path, or `@term/<package>/<path>` in the package's code root then its root, each by the
// candidates `<p>.tree`, `<p>/base.tree`, `<p>/note.tree`). A `{platform}` load and a bare package name are not
// followed. A shelved port (`mark draft`) is skipped, as the build skips it.
//
// ONE PARSER (note/project/term/one-parser.md): the loads and docks come from the compiler's parse tree, and the
// draft marker from `declaresDraft` (deck/call/code/draft.ts), never a regex over the text. This runs from the
// repository root, whose tsconfig has no `@term/*` paths, so both are imported through tsx's `tsImport` against
// tsconfig.json (term-cli-in-term-0239).
//
// Kept from tmp/cli-in-term-0065/aliases.mjs (term-cli-in-term-0213), which listed every alias naming two modules
// anywhere under deck/call/code; most of those never share a closure, so `--all` keeps that list as a report only.
//
//   pnpm term:dock-aliases          each collision in some port's closure, the files docking each module; exit 1 if any
//   pnpm term:dock-aliases --all    also every alias naming two modules anywhere under deck/call/code (never fails)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'
import { TERM_ROOT } from './root'

const REPO = TERM_ROOT
const TERM = TERM_ROOT
const DECK = join(TERM, 'deck')
const BASE = join(DECK, 'call', 'code')

const termImport = (specifier: string) =>
  tsImport(specifier, { parentURL: pathToFileURL(join(TERM, '/')).href, tsconfig: join(TERM, 'tsconfig.json') })

// filled by `main` before anything reads a file: the root package is CommonJS, so no top-level await
let parse: (source: { file: string; text: string }) => { ok: boolean; tree: { nodes: Array<unknown> } }
let declaresDraft: (text: string) => boolean

type Dock = { alias: string; module: string }

// the parser's node, as much of it as this reads
type Part = { kind: string; text?: string }
type Node = { kind: string; nodes?: Array<Node>; parts?: Array<Part> }

// a name or text node's plain text, or undefined when it interpolates (`{platform}`) or is another kind
function plainOf(node: Node | undefined): string | undefined {
  if (!node || (node.kind !== 'name' && node.kind !== 'text') || !node.parts) {
    return undefined
  }

  if (!node.parts.every(part => part.kind === 'chunk')) {
    return undefined
  }

  return node.parts.map(part => part.text ?? '').join('')
}

// the head word of a group: its first node, when that is a plain name
function headOf(node: Node | undefined): string | undefined {
  const first = node?.kind === 'group' ? node.nodes?.[0] : undefined

  return first?.kind === 'name' ? plainOf(first) : undefined
}

// a file's column-0 `load <path>` paths, and every `load <module>, name <alias>` at any depth (a dock)
function readTree(file: string, text: string): { loads: Array<string>; docks: Array<Dock> } {
  const parsed = parse({ file, text })
  const loads: Array<string> = []
  const docks: Array<Dock> = []

  if (!parsed.ok) {
    throw new Error(`${file} does not parse, so its loads and docks cannot be read`)
  }

  const visit = (group: Node, top: boolean): void => {
    if (headOf(group) === 'load') {
      const target = group.nodes?.[1]

      if (top && target?.kind === 'group') {
        const path = plainOf(target.nodes?.[0])

        if (path) {
          loads.push(path)
        }
      }

      if (target?.kind === 'text') {
        const module = plainOf(target)
        const named = group.nodes?.slice(2).find(node => headOf(node) === 'name')
        const alias = named?.kind === 'group' ? headOf(named.nodes?.[1]) : undefined

        if (module && alias) {
          docks.push({ alias, module })
        }
      }
    }

    for (const child of group.nodes?.slice(1) ?? []) {
      if (child.kind === 'group') {
        visit(child, false)
      }
    }
  }

  for (const group of parsed.tree.nodes as Array<Node>) {
    if (group.kind === 'group') {
      visit(group, true)
    }
  }

  return { loads, docks }
}

function* treeFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      yield* treeFiles(path)
    } else if (name.endsWith('.tree')) {
      yield path
    }
  }
}

function treeAt(path: string): string | undefined {
  for (const candidate of [`${path}.tree`, join(path, 'base.tree'), join(path, 'note.tree')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }

  return undefined
}

function resolveLoad(from: string, path: string): string | undefined {
  if (path.includes('{')) {
    return undefined
  }

  if (path.startsWith('./') || path.startsWith('../')) {
    return treeAt(join(dirname(from), path))
  }

  const match = /^@term\/([a-z0-9-]+)\/(.+)$/.exec(path)

  if (!match) {
    return undefined
  }

  return treeAt(join(DECK, match[1]!, 'code', match[2]!)) ?? treeAt(join(DECK, match[1]!, match[2]!))
}

const loadsOf = new Map<string, Array<string>>()
const docksOf = new Map<string, Array<Dock>>()

function readFile(file: string): void {
  if (loadsOf.has(file)) {
    return
  }

  const { loads, docks } = readTree(file, readFileSync(file, 'utf8'))
  const reached: Array<string> = []

  for (const path of loads) {
    const found = resolveLoad(file, path)

    if (found) {
      reached.push(found)
    }
  }

  loadsOf.set(file, reached)
  docksOf.set(file, docks)
}

function closureOf(port: string): Set<string> {
  const reached = new Set<string>()
  const stack = [port]

  while (stack.length > 0) {
    const file = stack.pop()!

    if (reached.has(file)) {
      continue
    }

    reached.add(file)
    readFile(file)
    stack.push(...loadsOf.get(file)!)
  }

  return reached
}

const shown = (file: string) => file.slice(DECK.length + 1)

async function main(): Promise<void> {
parse = (await termImport('@term/make/code/parser/tree')).parse
declaresDraft = (await termImport('@term/call/code/draft')).declaresDraft

const ports =[...treeFiles(BASE)].filter(file => !declaresDraft(readFileSync(file, 'utf8')))

// one line per collision, the ports whose closure holds it
const collisions = new Map<string, Array<string>>()

for (const port of ports) {
  // alias -> module -> the files of this closure docking it
  const byAlias = new Map<string, Map<string, Array<string>>>()

  for (const file of closureOf(port)) {
    for (const { alias, module } of docksOf.get(file)!) {
      const modules = byAlias.get(alias) ?? new Map<string, Array<string>>()
      const files = modules.get(module) ?? []

      files.push(shown(file))
      modules.set(module, files)
      byAlias.set(alias, modules)
    }
  }

  for (const [alias, modules] of byAlias) {
    if (modules.size < 2) {
      continue
    }

    const parts = [...modules].map(([module, files]) => `    ${module}: ${files.sort().join(', ')}`)
    const key = [`${alias}:`, ...parts].join('\n')
    const holders = collisions.get(key) ?? []

    holders.push(shown(port))
    collisions.set(key, holders)
  }
}

for (const [key, holders] of collisions) {
  console.log(key)
  console.log(`  in the closure of ${holders.length} port(s), first ${holders[0]}`)
}

if (process.argv.includes('--all')) {
  const anywhere = new Map<string, Set<string>>()

  for (const port of ports) {
    readFile(port)

    for (const { alias, module } of docksOf.get(port)!) {
      anywhere.set(alias, (anywhere.get(alias) ?? new Set()).add(module))
    }
  }

  const reused = [...anywhere].filter(([, modules]) => modules.size > 1)

  for (const [alias, modules] of reused) {
    console.log(`(anywhere) ${alias}: ${[...modules].join(', ')}`)
  }

  const docks = ports.reduce((sum, port) => sum + docksOf.get(port)!.length, 0)

  console.log(`docks read in ${ports.length} ports: ${docks}, over ${anywhere.size} aliases`)
  console.log(`aliases naming two modules anywhere under deck/call/code: ${reused.length}`)
}

console.log(`dock aliases naming two modules in one port's closure: ${collisions.size}`)
process.exit(collisions.size > 0 ? 1 : 0)
}

void main()
