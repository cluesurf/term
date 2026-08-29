// The mill grammar files (`deck/mill/code/<role>/{base,mine,mint}.tree`) are declarative: the compiler reads every
// dialect through its own passes today, so nothing executes them. This holds them correct anyway. Every file must
// parse, every `load` it makes must resolve to a file, every `find` must name something that file declares, and every
// `mint <x>, like <form>` must name a form a loaded stdlib module declares. The `host` and `mill` roles are the ones
// this gate holds to zero; the others are reported, and their count is the measure of the self-hosting mill's
// distance (see note/term/stdlib-gaps.md). The `host` grammar is also held to the data reader: the same five heads
// and the same six literals. The `deck` role (the manifest) and the `note` role (documents, its forms generated into seed/code/book.tree by `pnpm term:mill-forms`) were made correct and held on 2026-08-29. Run: npx tsx test/compile/mill-grammar.ts

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import type { GroupNode, Node } from '@term/make/code/parser/tree'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const MILL = join(TERM, 'deck/mill/code')
const SEED = join(TERM, 'deck/seed/code')

// the roles held to zero problems
const HELD = new Set(['host', 'mill', 'deck', 'note'])

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      walk(path, into)
    } else if (name.endsWith('.tree')) {
      into.push(path)
    }
  }

  return into
}

// where a `load` target lives: the stdlib, the mill package, or a relative path
function resolveLoad(target: string, from: string): string | undefined {
  let base: string

  if (target.startsWith('@term/seed/code/')) {
    base = join(SEED, target.slice('@term/seed/code/'.length))
  } else if (target.startsWith('@term/mill/code/')) {
    base = join(MILL, target.slice('@term/mill/code/'.length))
  } else if (target.startsWith('@term/host/code/')) {
    base = join(TERM, 'deck/host/code', target.slice('@term/host/code/'.length))
  } else if (target.startsWith('./') || target.startsWith('../')) {
    base = join(from, '..', target)
  } else {
    return undefined
  }

  for (const candidate of [`${base}.tree`, join(base, 'base.tree')]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

function headOf(group: GroupNode): string {
  const head = group.nodes[0]

  return head?.kind === 'name' ? head.parts.map(p => (p.kind === 'chunk' ? p.text : '')).join('') : ''
}

function wordAt(group: GroupNode, at: number): string {
  const node: Node | undefined = group.nodes[at]

  if (node?.kind === 'name') {
    return node.parts.map(p => (p.kind === 'chunk' ? p.text : '')).join('')
  }

  if (node?.kind === 'group') {
    return headOf(node)
  }

  return ''
}

// the names a file declares at the top level, by head
function declared(file: string): Set<string> {
  const parsed = parse({ file, text: readFileSync(file, 'utf8') })
  const names = new Set<string>()

  if (!parsed.ok) {
    return names
  }

  for (const group of parsed.tree.nodes) {
    const head = headOf(group)

    if (['form', 'task', 'mine', 'mint', 'mill', 'bind', 'mask', 'host'].includes(head)) {
      names.add(wordAt(group, 1))
    }
  }

  return names
}

type Problem = { file: string; what: string }

const problems: Problem[] = []
const files = walk(MILL)
let parsed = 0

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const tree = parse({ file, text })

  if (!tree.ok) {
    problems.push({ file, what: `does not parse: ${tree.diagnostics[0]?.message ?? ''}` })
    continue
  }

  parsed++

  // the forms the file's loads bring in, for `like` checks
  const known = new Set<string>()

  for (const group of tree.tree.nodes) {
    if (headOf(group) !== 'load') {
      continue
    }

    const target = wordAt(group, 1)
    const found = resolveLoad(target, file)

    if (!found) {
      problems.push({ file, what: `loads "${target}", which does not exist` })
      continue
    }

    const names = declared(found)

    for (const child of group.nodes.slice(2)) {
      if (child.kind === 'group' && headOf(child) === 'find') {
        const name = wordAt(child, 1)

        if (!names.has(name)) {
          problems.push({ file, what: `finds "${name}" in "${target}", which declares no such thing` })
        } else {
          known.add(name)
        }
      }
    }
  }

  for (const group of tree.tree.nodes) {
    if (headOf(group) !== 'mint') {
      continue
    }

    const like = group.nodes.find(n => n.kind === 'group' && headOf(n) === 'like') as GroupNode | undefined

    if (like) {
      const name = wordAt(like, 1)

      if (!known.has(name)) {
        problems.push({ file, what: `mints "like ${name}", which no load of this file brings in` })
      }
    }
  }
}

ok(`every grammar file parses (${parsed} of ${files.length})`, parsed === files.length)

const roleOf = (file: string): string => relative(MILL, file).split('/')[0] ?? ''
const held = problems.filter(p => HELD.has(roleOf(p.file)))
const rest = problems.filter(p => !HELD.has(roleOf(p.file)))

for (const role of HELD) {
  const own = held.filter(p => roleOf(p.file) === role)
  ok(
    `the ${role} grammar loads and finds only what exists`,
    own.length === 0,
    own.map(p => `${relative(MILL, p.file)}: ${p.what}`).join(' | '),
  )
}

// the host grammar agrees with the reader: the five heads, the compact spellings, the six literals
const hostMine = readFileSync(join(MILL, 'host/mine.tree'), 'utf8')

for (const head of ['host', 'list', 'mesh', 'tree', 'fuse']) {
  ok(`the host grammar reads "${head}"`, new RegExp(`mine term, term ${head}\\b`).test(hostMine))
}

ok('the host grammar captures text', /mine text\n\s+site text/.test(hostMine))
ok('the host grammar captures a number', /mine code\n\s+site number/.test(hostMine))

for (const word of ['true', 'false', 'void']) {
  ok(`the host grammar reads the word "${word}"`, new RegExp(`mine term, term ${word}\\b`).test(hostMine))
}

const byRole = new Map<string, number>()

for (const p of rest) {
  byRole.set(roleOf(p.file), (byRole.get(roleOf(p.file)) ?? 0) + 1)
}

console.log(
  `\n${rest.length} problem${rest.length === 1 ? '' : 's'} in the roles not held (${[...byRole]
    .map(([role, count]) => `${role} ${count}`)
    .join(', ')}); the self-hosting mill closes them`,
)

if (process.env.MILL_ALL) {
  for (const p of rest) {
    console.log(`      ${relative(MILL, p.file)}: ${p.what}`)
  }
}

console.log(`\nmill-grammar: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
