// Which recursive forms Rust holds in a `Box` (rust.ts, `boxableForms`, codegen-performance-0029), held both ways. A
// `Box` copies its whole subtree when cloned, so a form must be boxed only when the emitted program never clones it:
// a wrong `Box` costs a deep copy per clone, which for a program sharing structure is quadratic. Never a wrong answer,
// since under D1 a shared subtree and a copied one hold equal values; the meaning fixtures hold that.
// Run: npx tsx test/compile/rust-box.ts

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv } from '@term/make/code/compile/native'
import { emitRust, rustBoxing } from '@term/make/code/compile/rust'

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
const base = join(TERM, 'deck/base')
// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
const stdlib = stdlibResolver()!
const build = (file: string, text = readFileSync(file, 'utf8')) => {
  const built = compile({ file, text }, { resolve: withNativeEnv('rust', stdlib), env: 'rust' })

  if (!built.ok) {
    throw new Error(`${file}: ${built.diagnostics[0]?.message}`)
  }

  return built.program
}

// 1. built, consumed and summed, never cloned: boxed, and the emitted text says so
const boxes = build(join(TERM, 'test/compile/meaning-native/boxes.tree'))
const boxesFacts = rustBoxing(boxes)
ok('a chain nothing clones is boxed', JSON.stringify(boxesFacts.boxed) === '["chain"]', JSON.stringify(boxesFacts))
// a case holding the form keeps every field in ONE box, a payload struct (rust.ts, `payloads`): `Node(Box<ChainNode>)`,
// its child a plain `Chain` inside it, and an arm destructures the box with the fields' own pattern
const boxesRust = emitRust(boxes)
ok(
  'its node is one box, `Node(Box<ChainNode>)`, the child plain inside it',
  /Node\(Box<ChainNode>\)/.test(boxesRust) && /struct ChainNode \{ head: i64, rest: Chain \}/.test(boxesRust) && !/Box<Chain>/.test(boxesRust),
  boxesRust.split('\n').filter(l => /Chain|Node/.test(l)).slice(0, 8).join(' | '),
)
ok('an arm opens the box by its fields', /let ChainNode \{ [^}]*\} = /.test(boxesRust), boxesRust.split('\n').filter(l => /ChainNode/.test(l)).join(' | '))

// 2. binary-trees' tree, the benchmark this is for
const trees = rustBoxing(build(join(TERM, 'bench/binary-trees/term.tree')))
ok('binary-trees\' tree is boxed', JSON.stringify(trees.boxed) === '["tree"]', JSON.stringify(trees))

// 3. a form the program clones (`widest(small.clone(), big.clone())`) keeps its `Rc`
const borrow = rustBoxing(build(join(TERM, 'test/compile/meaning-native/borrow.tree')))
ok('a shape the program clones is NOT boxed', borrow.boxed.length === 0 && borrow.cloned.includes('shape'), JSON.stringify(borrow))

// 4. a form held inside another form that is cloned is cloned with it, so it is NOT boxed
const held = `form chain
  case stop
  case node
    link head, like number
    link rest, like chain

form box
  link inner, like chain

# the same box in two fields: the first use of b must clone it, and the clone copies the chain inside
form pair-of
  link first, like box
  link second, like box

task make-box
  take c, like chain
  like box
  send back
    make box
      bind inner, read c

task doubled
  take b, like box
  like pair-of
  send back
    make pair-of
      bind first, read b
      bind second, read b

task compute
  like text
  host p
    call doubled
      call make-box
        make stop
  send back, text <made>
`
const heldFacts = rustBoxing(build(join(TERM, 'tmp/rust-box-held.tree'), held))
ok(
  'a chain inside a box the program clones is NOT boxed',
  !heldFacts.boxed.includes('chain'),
  JSON.stringify(heldFacts),
)

// 5. Towers: the move keeps the box it opens in its own spare, and a text it raises hands the spare to the cold
// function, so the raise path drops nothing of its own; a task with no spare raises through `term_fail` alone
const towersRust = emitRust(build(join(TERM, 'bench/towers/term.tree')))
const moveTop = towersRust.slice(towersRust.indexOf('fn move_top('), towersRust.indexOf('\n}\n', towersRust.indexOf('fn move_top(')))
const buildTower = towersRust.slice(towersRust.indexOf('fn build_tower('), towersRust.indexOf('\n}\n', towersRust.indexOf('fn build_tower(')))
ok(
  'a raise in the task holding a spare hands it to `term_fail_with`',
  (moveTop.match(/Err\(term_fail_with\(__spare_stack, "/g) ?? []).length === 2 && !/Err\(term_fail\(/.test(moveTop),
  moveTop.split('\n').filter(l => /term_fail/.test(l)).join(' | '),
)
ok('a raise in a task with no spare is `term_fail`', /Err\(term_fail\("/.test(buildTower) && !/term_fail_with/.test(buildTower))
ok('`term_fail_with` is cold and out of line', /#\[cold\]\n#\[inline\(never\)\]\nfn term_fail_with<T>/.test(towersRust))

console.log(`\nrust-box: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
