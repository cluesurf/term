// The order a deck's TypeScript ports to Term in: its import graph, leaves first, cycles grouped.
//
// WHY A TOOL AND NOT A LIST. Self-hosting ports leaves first (note/project/term/self-host/04-the-port-switch.md): a module is
// ported only once everything it imports is already Term, so no port has to dock into TypeScript and nothing has to
// be undone later. The CLI port went top-down and ended with 30 docks. A list of that order written by a person goes
// stale the day any file gains an import, so the order is computed from the imports every time it is asked for.
//
// WHAT IT PRINTS. One CHUNK per strongly connected component of the import graph, in levels: level 0 imports nothing
// else in the deck, level n imports only chunks below n. A chunk of more than one file is a cycle and ports together,
// or is broken first. Each line carries the line count, so a level's size is visible before anybody starts it.
// Imports of OTHER decks are listed per chunk as what it waits on.
//
// It reads `import ... from`, `export ... from` and `import(...)` with relative specifiers and `@term/<deck>/code/...`
// ones. A `.tree` beside a `.ts` of the same name is marked, because it means a port of that file already exists.
//
//   pnpm term:port-order make          the compiler
//   pnpm term:port-order deck --flat   one file per line, in order, for a script to read

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { TERM_ROOT } from './root'

// run from the repository root, the way `pnpm term:port-order` runs it
const HOME = TERM_ROOT
const DECKS = join(TERM_ROOT, 'deck')

const argv = process.argv.slice(2)
const deck = argv.find(a => !a.startsWith('--'))
const flat = argv.includes('--flat')

if (!deck) {
  console.error('usage: pnpm term:port-order <deck> [--flat]')
  process.exit(2)
}

const CODE = join(DECKS, deck, 'code')

if (!existsSync(CODE)) {
  console.error(`term port-order: no ${relative(HOME, CODE)}`)
  process.exit(2)
}

const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'target', '.build'])

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.endsWith('-cache')) {
      continue
    }

    const full = join(dir, name)
    const stat = statSync(full)

    if (stat.isDirectory()) {
      walk(full, out)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !name.includes('.bak')) {
      out.push(full)
    }
  }
}

const files: string[] = []
walk(CODE, files)

const known = new Set(files)

// a specifier to a file of this deck, or a deck name when it leaves the deck, or undefined when it is node or npm
function target(from: string, spec: string): { file?: string; deck?: string } {
  let base: string | undefined

  if (spec.startsWith('.')) {
    base = join(dirname(from), spec)
  } else {
    const match = /^@term\/([^/]+)\/code\/(.+)$/.exec(spec)

    if (!match) {
      const other = /^@term\/([^/]+)/.exec(spec)
      return other ? { deck: `@term/${other[1]}` } : {}
    }

    if (match[1] !== deck) {
      return { deck: `@term/${match[1]}` }
    }

    base = join(CODE, match[2])
  }

  const stripped = base.replace(/\.(js|ts|tsx)$/, '')

  for (const candidate of [`${stripped}.ts`, `${stripped}.tsx`, join(stripped, 'index.ts')]) {
    if (known.has(candidate)) {
      return { file: candidate }
    }
  }

  return {}
}

const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g

const edges = new Map<string, Set<string>>()
const outside = new Map<string, Set<string>>()
const lines = new Map<string, number>()

for (const file of files) {
  const text = readFileSync(file, 'utf8')

  lines.set(file, text.split('\n').length)
  edges.set(file, new Set())
  outside.set(file, new Set())

  for (const match of text.matchAll(IMPORT)) {
    const spec = match[1] ?? match[2] ?? match[3]
    const hit = target(file, spec)

    if (hit.file && hit.file !== file) {
      edges.get(file)!.add(hit.file)
    } else if (hit.deck) {
      outside.get(file)!.add(hit.deck)
    }
  }
}

// Tarjan, iteratively so a deep import chain cannot overflow the stack
function components(): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const found: string[][] = []
  let next = 0

  for (const start of files) {
    if (index.has(start)) {
      continue
    }

    const work: Array<{ node: string; it: Iterator<string> }> = []

    const enter = (node: string): void => {
      index.set(node, next)
      low.set(node, next)
      next++
      stack.push(node)
      onStack.add(node)
      work.push({ node, it: edges.get(node)![Symbol.iterator]() })
    }

    enter(start)

    while (work.length > 0) {
      const top = work[work.length - 1]
      const step = top.it.next()

      if (!step.done) {
        const to = step.value

        if (!index.has(to)) {
          enter(to)
        } else if (onStack.has(to)) {
          low.set(top.node, Math.min(low.get(top.node)!, index.get(to)!))
        }

        continue
      }

      work.pop()

      if (work.length > 0) {
        const parent = work[work.length - 1].node
        low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!))
      }

      if (low.get(top.node) === index.get(top.node)) {
        const group: string[] = []
        let member: string

        do {
          member = stack.pop()!
          onStack.delete(member)
          group.push(member)
        } while (member !== top.node)

        found.push(group.sort())
      }
    }
  }

  return found
}

const groups = components()
const groupOf = new Map<string, number>()

groups.forEach((group, i) => group.forEach(file => groupOf.set(file, i)))

// a group's level is one more than the highest level it imports; Tarjan emits a group after every group it reaches
const level = new Array<number>(groups.length).fill(0)

groups.forEach((group, i) => {
  for (const file of group) {
    for (const to of edges.get(file)!) {
      const j = groupOf.get(to)!

      if (j !== i) {
        level[i] = Math.max(level[i], level[j] + 1)
      }
    }
  }
})

const order = groups
  .map((group, i) => ({ group, level: level[i] }))
  .sort((a, b) => a.level - b.level || a.group[0].localeCompare(b.group[0]))

const ported = (file: string): boolean => existsSync(file.replace(/\.tsx?$/, '.tree'))

if (flat) {
  for (const { group } of order) {
    for (const file of group) {
      console.log(relative(CODE, file))
    }
  }

  process.exit(0)
}

const total = files.reduce((sum, file) => sum + lines.get(file)!, 0)
const cycles = order.filter(({ group }) => group.length > 1)

console.log(`term port-order: @term/${deck}, ${files.length} files, ${total} lines`)
console.log(`  ${order.length} chunks in ${Math.max(0, ...level) + 1} levels, ${cycles.length} of them cycles`)

let current = -1

for (const { group, level: at } of order) {
  if (at !== current) {
    current = at
    const atLevel = order.filter(entry => entry.level === at)
    const size = atLevel.reduce((sum, entry) => sum + entry.group.reduce((s, f) => s + lines.get(f)!, 0), 0)

    console.log('')
    console.log(`level ${at}: ${atLevel.length} chunks, ${size} lines`)
  }

  const size = group.reduce((sum, file) => sum + lines.get(file)!, 0)
  const waits = [...new Set(group.flatMap(file => [...outside.get(file)!]))].sort()
  const head = group.length > 1 ? `cycle of ${group.length}, ${size} lines` : `${size} lines`

  console.log(`  ${group.map(file => `${relative(CODE, file)}${ported(file) ? ' (has .tree)' : ''}`).join(', ')}`)
  console.log(`      ${head}${waits.length > 0 ? `, waits on ${waits.join(' ')}` : ''}`)
}
