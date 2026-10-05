// Rust moves the last of several reads of a name in one statement when every earlier one there was a clone, and holds a
// form the program clones as one `Rc` around its payload (rust.ts, `manyMoves`, `payloads`; backend.ts, `lastReads`).
// Held both ways: List's `tail` moves its third call's lists, and a statement whose earlier read is a borrow, and a read
// inside a loop, keep their clones, since a move there would meet a live borrow (E0505) or the next turn's read (E0382).
// Each emitted program is built by rustc.
// Run: npx tsx test/compile/rust-moves.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const TERM = join(import.meta.dirname, '../..')
const dir = mkdtempSync(join(tmpdir(), 'term-rust-moves-'))
const rust = (text: string, entry: string, file = 'main.tree'): string => {
  const built = compile({ file, text }, { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: [entry] })

  if (!built.ok) {
    throw new Error(`${file}: ${built.diagnostics[0]?.message}`)
  }

  return `${nativePrelude(built.program, 'rust', () => undefined)}\n${emitRust(built.program)}`
}
// whether rustc builds the program as a library: a move it cannot make is E0382 or E0505
const builds = (label: string, text: string): { ok: boolean; errors: string } => {
  const path = join(dir, `${label}.rs`)
  writeFileSync(path, text)
  const out = spawnSync('rustc', ['--edition', '2021', '--crate-type', 'lib', '-A', 'warnings', '-o', join(dir, `lib${label}.rlib`), path], { encoding: 'utf8' })

  return { ok: out.status === 0, errors: out.stderr.split('\n').filter(l => /^error/.test(l)).join(' | ') }
}
const lines = (text: string, pattern: RegExp): string => text.split('\n').filter(l => pattern.test(l)).join(' | ')

// 1. List: the payload behind one `Rc`, and `tail`'s third call moving each list at its last read
const list = rust(readFileSync(join(TERM, 'mark/list/term.tree'), 'utf8'), 'list-runs', 'mark/list/term.tree')
ok('list: a cloned form holds its payload in one Rc', /Link\(std::rc::Rc<ChainLink>\)/.test(list) && /struct ChainLink \{ value: i64, next: Chain \}/.test(list), lines(list, /Link|ChainLink/))
ok('list: the third call moves z, x and y', /tail\(rest\(z\), x, y\)/.test(list), lines(list, /return tail/))
ok('list: the earlier calls still clone', /tail\(rest\(x\.clone\(\)\), y\.clone\(\), z\.clone\(\)\)/.test(list), lines(list, /return tail/))
ok('list: rustc builds it', builds('list', list).ok, builds('list', list).errors)

// 2. an earlier read that is a BORROW: `peek` only reads its chain, so it takes it as `&`, and the last read after it
// must clone, or the move would meet the live borrow
const chain = `form chain
  case end
  case link
    link value, like number
    link next, like chain

task peek
  take c, like chain
  like number
  fork case, read c
    case end
      send back, code 0
    case link
      send back, read value

task keep
  take c, like chain
  take n, like number
  like chain
  fork test
    hook test
      call is-above
        read n
        code 0
    hook hold
      send back
        make link
          bind value, read n
          bind next, read c
  send back, read c
`

const borrowed = rust(
  `${chain}
task use
  take c, like chain
  like chain
  send back
    call keep
      read c
      call peek(read(c))
`,
  'use',
)
ok('a read beside a borrow of its name keeps its clone', !/keep\(c, /.test(borrowed), lines(borrowed, /keep\(/))
ok('rustc builds it', builds('borrowed', borrowed).ok, builds('borrowed', borrowed).errors)

// the borrow FIRST, the read by value last: `wrap(peek(&c), c)` would move `c` while `&c` is still an argument
const borrowFirst = rust(
  `${chain}
task wrap
  take n, like number
  take c, like chain
  like chain
  send back
    make link
      bind value, read n
      bind next, read c

task use
  take c, like chain
  like chain
  send back
    call wrap
      call peek(read(c))
      read c
`,
  'use',
)
ok('a read after a borrow of its name keeps its clone', /wrap\(peek\(&c\), c\.clone\(\)\)/.test(borrowFirst), lines(borrowFirst, /wrap\(/))
ok('rustc builds it', builds('borrow-first', borrowFirst).ok, builds('borrow-first', borrowFirst).errors)

// 3. a read inside a loop: the next turn reads it again, so no read there is last
const looped = rust(
  `${chain}
task use
  take c, like chain
  like number
  save total, code 0
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        code 3
    hook hold
      save total
        call add
          read total
          call peek(call keep(read(c), call peek(call keep(read(c), code 1))))
      save i
        call add
          read i
          code 1
  send back, read total
`,
  'use',
)
ok('a read inside a loop is never moved', !/keep\(c, /.test(looped), lines(looped, /keep\(/))
ok('rustc builds it', builds('looped', looped).ok, builds('looped', looped).errors)

console.log(`\nrust-moves: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
