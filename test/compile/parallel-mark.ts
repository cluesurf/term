// `walk xs, mark parallel` (decision 021 section 1 of note/project/term/self-host/change/001-finish-self-host): the walk
// grammar's `mark` part, whose one word is `parallel`, mints a `for-each` with `parallel` set, in lean and in longhand,
// beside `name outer`. An unmarked walk mints no `parallel` key. `mark parallel` on `walk size` or `walk test`, and any
// other word in a walk's `mark`, is refused as `parallel-walk-mode`. Nothing runs in parallel yet: a marked walk emits
// the same TypeScript and Rust as the unmarked one. Item term-self-host-001-0231.
// Run: npx tsx test/compile/parallel-mark.ts (from deck/term/deck/term)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { projectResolver } from '@term/call/code/make'

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

type Node = Record<string, any>

// every for-each the mill builds of a source, read in lean or in longhand
function walks(text: string, lean: boolean): { loops: Node[]; said: { name: string; message: string }[] } {
  const parsed = parse({ file: '/gate/code/walks.tree', text })
  if (!parsed.ok) return { loops: [], said: [{ name: 'parse', message: 'did not parse' }] }
  const built = mill(parsed.tree, '/gate/code/walks.tree', undefined, lean) as { ok: boolean; program?: Node[]; diagnostics?: Node[] }
  const loops: Node[] = []
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const record = value as Node
    if (record.form === 'for-each') loops.push(record)
    for (const [key, inner] of Object.entries(record)) if (key !== 'span') visit(inner)
  }
  visit(built.program ?? [])

  return { loops, said: (built.diagnostics ?? []).map(d => ({ name: String(d.name), message: String(d.message) })) }
}

const LEAN_MARKED = `task total
  take xs, like list, like number
  like number
  save sum, 0
  walk xs, mark parallel
    take x
    save sum, add(sum, x)
  back sum
`

const LEAN_NAMED = `task total
  take xs, like list, like number
  like number
  save sum, 0
  walk xs, name outer
    mark parallel
    take x
    take at
    save sum, add(sum, x)
  back sum
`

const LONG_MARKED = `task total
  take xs, like list, like number
  like number
  save sum, code 0
  walk list, read xs
    mark parallel
    take x
    save sum
      call add
        read sum
        read x
  send back, read sum
`

const UNMARKED = LEAN_MARKED.replace(', mark parallel', '')

const lean = walks(LEAN_MARKED, true)
ok('lean: `walk xs, mark parallel` mints a for-each with parallel true', lean.loops.length === 1 && lean.loops[0]!.parallel === true && lean.said.length === 0, JSON.stringify(lean))

const named = walks(LEAN_NAMED, true)
ok(
  'lean: `mark parallel, name outer` composes: parallel, its label and its index',
  named.loops.length === 1 && named.loops[0]!.parallel === true && named.loops[0]!.label === 'outer' && named.loops[0]!.index === 'at' && named.said.length === 0,
  JSON.stringify(named),
)

const long = walks(LONG_MARKED, false)
ok('longhand: `walk list, read xs` with `mark parallel` as a child line mints parallel true', long.loops.length === 1 && long.loops[0]!.parallel === true && long.said.length === 0, JSON.stringify(long))

const plain = walks(UNMARKED, true)
ok('an unmarked walk mints no parallel key', plain.loops.length === 1 && !('parallel' in plain.loops[0]!) && plain.said.length === 0, JSON.stringify(plain))

const counted = walks(`task total
  take n, like number
  like number
  save sum, 0
  walk size, mark parallel
    bind head, n
    take i
    save sum, add(sum, i)
  back sum
`, true)
ok(
  '`mark parallel` on `walk size` is refused as parallel-walk-mode',
  counted.said.some(d => d.name === 'parallel-walk-mode' && d.message.includes('a parallel walk walks a list')),
  JSON.stringify(counted.said),
)

const tested = walks(`task count
  take n, like number
  like number
  save i, 0
  walk test, mark parallel
    hook test, is-below(i, n)
    hold
      save i, add(i, 1)
  back i
`, true)
ok(
  '`mark parallel` on `walk test` is refused as parallel-walk-mode',
  tested.said.some(d => d.name === 'parallel-walk-mode' && d.message.includes('a parallel walk walks a list')),
  JSON.stringify(tested.said),
)

const other = walks(LEAN_MARKED.replace('mark parallel', 'mark quick'), true)
ok(
  'another word in a walk\'s mark is refused by name',
  other.said.some(d => d.name === 'parallel-walk-mode' && d.message.includes('`mark quick`')),
  JSON.stringify(other.said),
)

// every emitter ignores the field: the marked walk emits what the unmarked one does
const dir = mkdtempSync(join(tmpdir(), 'term-parallel-mark-'))
const program = (marked: boolean): string => `load @term/base/list
  find list

task total
  take xs, like list, like number
  like number
  save sum, 0
  walk xs${marked ? ', mark parallel' : ''}
    take x
    save sum, add(sum, x)
  back sum
`

for (const env of ['node', 'rust']) {
  const emitted = (marked: boolean): string | undefined => {
    const built = compile({ file: join(dir, 'total.tree'), text: program(marked) }, { resolve: projectResolver(process.cwd(), env), env } as never) as {
      ok: boolean
      typescript?: string
      program?: unknown[]
      diagnostics?: Node[]
    }
    if (!built.ok) return `refused: ${(built.diagnostics ?? []).map(d => d.message).join(' | ')}`
    return env === 'rust' ? emitRust(built.program as never) : built.typescript
  }
  const before = emitted(false)
  const after = emitted(true)
  ok(`${env === 'rust' ? 'Rust' : 'TypeScript'}: a marked walk emits what the unmarked one does`, before !== undefined && !String(before).startsWith('refused') && before === after, `${String(before).slice(0, 200)} / ${String(after).slice(0, 200)}`)
}

console.log(`\nparallel-mark: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
