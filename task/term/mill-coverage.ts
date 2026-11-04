// Does the CODE role's grammar match the WHOLE stdlib through the executor? Held to zero misses: a grammar
// change that stops matching a stdlib file, or a stdlib construct the grammar cannot say, fails this gate.
// The per-file first-failure tally names what broke. Run from the Term root (the pnpm alias does).
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse, renderHead } from '@term/make/code/parser/tree'
import { readMineGrammar, runMine, spanOfNode } from '@term/make/code/compile/mill-run'
import { resolveMillImport } from '@term/make/code/compile/mill-load'
import { projectRoleOf } from '@term/call/code/role-of'
import { PARENT_ROOT, TERM_ROOT, parentRoot } from './root'

const TERM = TERM_ROOT
const MILL = join(TERM, 'deck/mill/code/tree')
const DECK = join(TERM, 'deck')

// Every package's `.tree` code, not just the stdlib. Reading the stdlib is not reading the language: `site`
// writes routes, `face` writes views, `zone` writes its own dialect, and a grammar proven on the stdlib alone was
// proven on one package (found by pnpm term:mint-parity, 2026-08-31). `base` is the stdlib since 2026-10-02.
const PACKAGES = ['base', 'site', 'face', ...(PARENT_ROOT ? ['zone'] : []), 'call', 'make', 'deck', 'flow', 'host', 'test', 'scan']

// where a package lives: inside the Term tree, except zone, which moved to the repository's deck/zone on 2026-10-02
// and still writes its own dialect, so it stays in the measure
const packageDir = (pkg: string): string => (pkg === 'zone' ? join(parentRoot(), 'deck/zone') : join(DECK, pkg))

const seen = new Set<string>()
const parts: string[] = []
function collect(file: string): void {
  if (seen.has(file) || !existsSync(file)) return
  seen.add(file)
  const text = readFileSync(file, 'utf8')
  // the grammar text WITHOUT its import block, and the paths it imports, both read from the parse tree. There is
  // ONE parser for `.tree` (note/project/term/one-parser.md): the regexes this replaced stripped a `load` line written
  // inside a `text <...>` literal and missed a path carrying an interpolation. tree-parser-0010.
  const parsed = parse({ file, text })
  const tree = parsed.ok ? parsed.tree : undefined
  const imports: string[] = []

  if (tree) {
    const lines = text.split('\n')
    const drop = new Set<number>()

    for (const group of tree.nodes) {
      const first = group.nodes[0]
      const name = first?.kind === 'name' ? renderHead(first) : undefined

      if (name !== 'load') {
        continue
      }

      // every line this statement spans, so the import block is removed exactly rather than by pattern
      const span = spanOfNode(group)
      const end = spanOfNode(group.nodes[group.nodes.length - 1]!)

      for (let i = span?.start.line ?? 0; i <= (end?.end.line ?? span?.start.line ?? 0); i++) {
        drop.add(i)
      }

      const target = group.nodes[1]

      if (target?.kind === 'group') {
        const head = target.nodes[0]

        if (head?.kind === 'name') {
          imports.push(renderHead(head))
        }
      }
    }

    parts.push(lines.filter((_, i) => !drop.has(i)).join('\n'))
  } else {
    parts.push(text)
  }

  // the mill's own load rule (`resolveMillImport`, the package path rule), never a prefix table of its own
  for (const path of imports) {
    const found = resolveMillImport(MILL, file, path)

    if (found) { collect(found) }
  }
}
collect(join(MILL, 'code/mine.tree'))
const g = parse({ file: 'code-grammar.tree', text: parts.join('\n\n') })
if (!g.ok) { console.log('grammar parse fail:', g.diagnostics[0]?.message); process.exit(1) }
const grammar = readMineGrammar(g.tree)
console.log('rules:', grammar.size)

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, into)
    else if (name.endsWith('.tree')) into.push(p)
  }
  return into
}

// The component and style dialects. A file with a top-level `view`, `face` or `tone` head is written in a
// dialect the CODE role does not read yet: `view` is the component head, `face` and `tone` the look / CSS one.
// Bringing them under the code role is the `view-rename` project (note/project/term/archive/view-rename.md), which is
// blocked on `view-dialect` and being worked in parallel. Reaching into that grammar here would collide with
// it, so these files are named skips with the project that owns them, not silent passes.
//
// `mill.ts` mills them today through its generic "an unknown head is a call" path, which is quirk 5's family:
// what it produces is not a program either.
const VIEW_DIALECT = /^(view|face|tone)\b/m

function inViewDialect(text: string): boolean {
  return VIEW_DIALECT.test(text)
}

let match = 0, noMatch = 0, parseFail = 0, draft = 0, viewDialect = 0
const misses: string[] = []
const causes = new Map<string, { count: number; sample: string; file: string }>()
function lineOf(text: string, node: any): string {
  const span = spanOfNode(node)
  const ln = span?.start?.line ?? span?.line
  if (ln === undefined) return '?'
  const row = text.split('\n')[ln] ?? text.split('\n')[ln - 1] ?? '?'
  return row.trim()
}
// A package's `role.tree` says which mill reads which file. A file whose role is not `code` is read by another
// grammar entirely (`site` and `call` for routes and commands), so measuring it against the code role would be
// measuring the wrong question. This is the compiler's own resolver, not a second answer to the same question.
const roleOf = new Map<string, ReturnType<typeof projectRoleOf>>()
const roleFor = (pkg: string): ReturnType<typeof projectRoleOf> => {
  const known = roleOf.get(pkg)
  if (known) return known
  const made = projectRoleOf(packageDir(pkg))
  roleOf.set(pkg, made)
  return made
}
let otherRole = 0
const pool: string[] = []
for (const name of PACKAGES) {
  const code = join(packageDir(name), 'code')
  if (!existsSync(code)) continue
  for (const file of walk(code)) {
    const role = roleFor(name)(file)
    if (role && role !== 'code') { otherRole++; continue }
    pool.push(file)
  }
}
for (const file of pool) {
  const text = readFileSync(file, 'utf8')
  if (/^(mark|note) draft$/m.test(text)) { draft++; continue }
  if (inViewDialect(text)) { viewDialect++; continue }
  const p = parse({ file, text })
  if (!p.ok) { parseFail++; continue }
  const m = runMine(grammar, 'code', p.tree)
  if (m.ok) { match++; continue }
  noMatch++
  if (misses.length < 12) misses.push(relative(DECK, file))
  // find the FIRST top-level node that fails alone, and record its head line
  for (const node of p.tree.nodes) {
    const sub = { ...p.tree, nodes: [node] }
    const r = runMine(grammar, 'code', sub)
    if (!r.ok) {
      const sample = lineOf(text, node)
      const key = sample.split(/[\s,(]/)[0] ?? '?'
      const c = causes.get(key)
      if (c) c.count++
      else causes.set(key, { count: 1, sample, file: relative(DECK, file) })
      break
    }
  }
}
console.log(`code grammar: ${match} match, ${noMatch} no-match, ${parseFail} parse-fail, ${draft} draft-skipped, ${otherRole} in another role, ${viewDialect} in the view dialect (view-rename)`)
console.log(`mill-coverage: ${match} pass, ${noMatch + parseFail} fail`)
if (noMatch > 0 || parseFail > 0) process.exitCode = 1
console.log('sample misses:', misses.join(', '))
console.log('first-failure heads:')
for (const [key, c] of [...causes.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20)) {
  console.log(`  ${String(c.count).padStart(4)}  ${key}  e.g. "${c.sample.slice(0, 60)}" (${c.file})`)
}
