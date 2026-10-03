// One Term program means one thing on every backend: two programs whose answers used to depend on the backend, run
// on TypeScript, Rust, Swift and Kotlin with the real toolchains, each held to ONE expected answer.
//
//   order     a `hash` walked in insertion order. On 2026-10-02 Rust and Swift walked it in a different order on
//             every run of the same binary, because both seed their hash per process (optimize-0001, -0002)
//   equality  `is-equal` on records compares their fields, and a record key is found by an equal record. On
//             2026-10-02 it was identity on TypeScript, structure on Kotlin, and a compile error on Rust and Swift
//             (optimize-0003, -0041)
//
// Every native program runs TWICE, because a per-process hash seed is exactly what one run cannot see.
// note/term/optimize/meaning.md. MN_ONLY=rust (or swift, kotlin, typescript) runs one backend.
// Run: npx tsx test/compile/meaning-native.ts

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeFlags } from './native-flags'
import { parse } from '@term/make/code/parser/tree'
import { stdlibResolver } from '@term/make/code/resolve'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { emitRust } from '@term/make/code/compile/rust'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import type { Program } from '@term/make/code/compile/node'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, got: string, want: string): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}\n        got  ${got}\n        want ${want}`)
  }
}

function skipped(name: string, why: string): void {
  skip++
  console.log(`skip  ${name}  (${why})`)
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

// 20 keys out of sorted order. `fig` is deleted and set again, so it moves to the end, and `pear` is set a second
// time, so it keeps its place: the two rules of insertion order a hash table forgets
const KEYS = [
  'pear', 'apple', 'zebra', 'mango', 'kiwi', 'banana', 'quince', 'fig', 'yam', 'cherry',
  'lime', 'date', 'olive', 'grape', 'nut', 'elder', 'hops', 'jujube', 'ugli', 'tomato',
]

const ORDER = `load @term/base/code/hash
  find hash

task compute
  like text
  save m
    make find
${KEYS.map(
  (key, i) => `  call set
    read m
    text <${key}>
    code ${i}`,
).join('\n')}
  call remove
    read m
    text <fig>
  call set
    read m
    text <fig>
    code 99
  call set
    read m
    text <pear>
    code 98
  host names
    call keys
      read m
  save out, text <>
  walk list, read names
    hook next
      take site, name key
      save out, text <{{out}}{{key}} >
  send back, read out
`

const ORDER_WANT = [...KEYS.filter(k => k !== 'fig'), 'fig'].join(' ')

const EQUALITY = readFileSync(join(import.meta.dirname, 'meaning-native/equality.tree'), 'utf8')

// a `mark shared` value is compared, and keyed, by identity on every backend, alone and as a record's field
const EQUALITY_WANT =
  'equal-fields=true different-fields=false same-name=true lines-equal=true lists-equal=true lists-differ=false ' +
  'variants-equal=true variants-differ=false empties-equal=true shared-by-identity=false shared-self=true ' +
  'key-c-found=false size=1 value-by-equal-key=2 holders-same=true holders-other=false ' +
  'shared-key-same=true shared-key-other=false'

// the counting pieces in @term/base/code/count (optimize-0007), and the two `count-each` twin bodies written as
// plain tasks and compared with the reference over 40 generated input pairs each. The second is also what found the
// Rust backend writing a list slot by a computed index as `xs.borrow()[i].clone() = v` (E0070)
const COUNT = readFileSync(join(import.meta.dirname, 'meaning-native/count.tree'), 'utf8')
const COUNT_WANT = 'counts=3,0,1,3 tally-5=3 keys=3 within=true outside=false filled=3 read-in=7 read-out=0'
const COUNT_TWINS = readFileSync(join(import.meta.dirname, 'meaning-native/count-twins.tree'), 'utf8')
const COUNT_TWINS_WANT = 'agree=80 disagree=0'

// text by code point, across surrogate pairs (codegen-performance: Kotlin's TermText reads the String in place)
const TEXT = readFileSync(join(import.meta.dirname, 'meaning-native/text.tree'), 'utf8')
const TEXT_WANT = 'length=5 at=😀 code=128512 past=[] y=2 later=4 last=4 middle=😀y parts=5 trimmed=[a😀] padded=ab😀'

// map, filter, concat, reverse and pop, which the Kotlin emitter now writes with one copy and never `removeLast()`,
// and a quotient that truncates toward zero
const LISTS = readFileSync(join(import.meta.dirname, 'meaning-native/lists.tree'), 'utf8')
const LISTS_WANT = 'd0=8 d3=4 b0=4 b1=7 both=6 r0=2 popped=2 left=3 quotient=-3'

// the swap of two list slots, one call on Swift, Rust and Kotlin, and the two near-misses that stay three statements
const SWAP = readFileSync(join(import.meta.dirname, 'meaning-native/swap.tree'), 'utf8')
const SWAP_WANT = 'flip=4,0,5 same=2 shared=5,4 kept=3 k=1,3 rotate=1,1,5'

// function parameters only called (`impl Fn` on Rust), passed as a literal, a capture, a variable, a named task and a
// result-less callback, beside one passed on (an `Rc<dyn Fn>` still)
const CLOSURES = readFileSync(join(import.meta.dirname, 'meaning-native/closures.tree'), 'utf8')
const CLOSURES_WANT = 'literal=7 captured=21 held=81 named=18 seen=4,3 summed=14'

// list parameters lent on Rust (`&mut Vec<T>`, `&[T]`): the caller sees the write, an argument reading the same list,
// a list made in the call, and a task passing its list on
const LEND = readFileSync(join(import.meta.dirname, 'meaning-native/lend.tree'), 'utf8')
// record parameters only read (`&R` on Rust): matched, fields passed on borrowed, number and text fields read out,
// beside a task that hands its record back and so keeps it by value
const BORROW = readFileSync(join(import.meta.dirname, 'meaning-native/borrow.tree'), 'utf8')
const BORROW_WANT = 'small=4 big=25 labels=b.c widest=25 again=25 bumped=6 each=33'
const LEND_WANT ='after=4 self-read=2 shared=9 sum=117 fresh=14 owned=100,2,10101,6'

// two lists lent to one call, one written: the same list passed in both places refuses the lend everywhere
const ALIAS = readFileSync(join(import.meta.dirname, 'meaning-native/alias.tree'), 'utf8')
const ALIAS_WANT = 'same=1,3 apart=0,1'

// a recursive form nothing clones, held in a `Box` on Rust: built, consumed by a reversal moving each child out, summed
const BOXES = readFileSync(join(import.meta.dirname, 'meaning-native/boxes.tree'), 'utf8')
const BOXES_WANT = 'sum=15 first=1'

// records in a list written back in place on TypeScript and Kotlin (compile/place.ts): the pair loop that may, and an
// old value read after the write, two indices that can be one, and a record kept in a local too, which may not
const PLACE = readFileSync(join(import.meta.dirname, 'meaning-native/place.tree'), 'utf8')
const PLACE_WANT = 'p0=107,10 p1=5,35 p2=3,73 old=6 pin=1'

// a record is a value (D1): a task's field write, a second name written through, a write two fields deep and a record
// read from a list, none reaching the caller's (codegen-performance-0028)
const RECORDS = readFileSync(join(import.meta.dirname, 'meaning-native/records.tree'), 'utf8')
const RECORDS_WANT = 'inside=6 twice=6 caller=5 alias=7 deep=99 outer=5 list=4 kept=3'

const baseTree = join(process.cwd(), 'deck', 'base')
const STDLIB_PREFIX = /^@term\/base\//

// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
const stdlib = stdlibResolver()!

const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  if (!STDLIB_PREFIX.test(path)) {
    return undefined
  }

  const file = join(baseTree, path.replace(STDLIB_PREFIX, ''))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

function frontEnd(text: string, env: 'rust' | 'swift' | 'kotlin' | 'node'): Program {
  const sources = collectModules({ file: 'main.tree', text }, withNativeEnv(env, stdlib)).sources
  const program: Program = []
  const roots = new Set<string>()

  for (const unit of sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error(`parse failed: ${unit.file}`)
    }

    const built = mill(parsed.tree, unit.file)

    if (!built.ok) {
      throw new Error('mill failed: ' + built.diagnostics.map(d => d.message).join(', '))
    }

    if (unit.file === 'main.tree') {
      for (const node of built.program) {
        if (node.form === 'function') {
          roots.add(node.name)
        }
      }
    }

    program.push(...built.program)
  }

  resolveNames(program, 'main.tree')
  check(program, 'main.tree')

  return simplify(program, roots)
}

const dir = mkdtempSync(join(tmpdir(), 'meaning-native-'))
const only = process.env.MN_ONLY ?? ''

// the first lines of a build's errors, never its warnings
function errors(error: unknown): string {
  const text = String((error as { stderr?: Buffer }).stderr ?? error)
  const lines = text.split('\n')
  const found = lines.flatMap((line, i) => (/error(\[E\d+\])?:/.test(line) ? lines.slice(i, i + 3) : []))

  return (found.length ? found : lines).slice(0, 12).join('\n        ')
}

function run(backend: string, label: string, text: string, want: string): void {
  const name = `${backend}: ${label}`

  try {
    if (backend === 'typescript') {
      const program = frontEnd(text, 'node')
      const file = join(dir, `${label}.ts`)
      writeFileSync(file, `${nativePrelude(program, 'node', readRuntime)}\n${emitTypeScript(program)}\nprocess.stdout.write(String(compute()))\n`)
      ok(name, execFileSync('npx', ['tsx', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(), want)

      return
    }

    let exe: string[]

    if (backend === 'rust') {
      const program = frontEnd(text, 'rust')
      const file = join(dir, `${label}.rs`)
      writeFileSync(file, `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(program)}\nfn main() { print!("{}", compute()); }\n`)
      execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', join(dir, `${label}-rs`)], { stdio: ['ignore', 'pipe', 'pipe'] })
      exe = [join(dir, `${label}-rs`)]
    } else if (backend === 'swift') {
      const program = frontEnd(text, 'swift')
      const file = join(dir, `${label}.swift`)
      writeFileSync(file, `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(program)}\nprint(compute(), terminator: "")\n`)
      execFileSync('swiftc', [...nativeFlags('swift'), '-o', join(dir, `${label}-swift`), file], { stdio: ['ignore', 'pipe', 'pipe'] })
      exe = [join(dir, `${label}-swift`)]
    } else {
      const program = frontEnd(text, 'kotlin')
      const file = join(dir, `${label}.kt`)
      const jar = join(dir, `${label}.jar`)
      writeFileSync(file, hoistKotlinImports(`${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(program)}\nfun main() { print(compute()) }\n`))
      execFileSync('kotlinc', [file, ...nativeFlags('kotlin'), '-include-runtime', '-d', jar], { stdio: ['ignore', 'pipe', 'pipe'] })
      exe = ['java', '-jar', jar]
    }

    // twice: a per-process hash seed is invisible to one run
    for (const turn of ['first run', 'second run']) {
      ok(`${name}, ${turn}`, execFileSync(exe[0]!, exe.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(), want)
    }
  } catch (error) {
    fail++
    console.log(`FAIL  ${name}  (build or run failed)\n        ${errors(error)}`)
  }
}

const TOOL: Record<string, string[]> = { typescript: [], rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }

for (const backend of ['typescript', 'rust', 'swift', 'kotlin']) {
  if (only && only !== backend) {
    continue
  }

  const missing = TOOL[backend]!.filter(tool => !have(tool))

  if (missing.length) {
    skipped(backend, `${missing.join(', ')} not installed`)
    continue
  }

  run(backend, 'order', ORDER, ORDER_WANT)
  run(backend, 'equality', EQUALITY, EQUALITY_WANT)
  run(backend, 'count', COUNT, COUNT_WANT)
  run(backend, 'count-twins', COUNT_TWINS, COUNT_TWINS_WANT)
  run(backend, 'text', TEXT, TEXT_WANT)
  run(backend, 'lists', LISTS, LISTS_WANT)
  run(backend, 'swap', SWAP, SWAP_WANT)
  run(backend, 'closures', CLOSURES, CLOSURES_WANT)
  run(backend, 'lend', LEND, LEND_WANT)
  run(backend, 'borrow', BORROW, BORROW_WANT)
  run(backend, 'boxes', BOXES, BOXES_WANT)
  run(backend, 'alias', ALIAS, ALIAS_WANT)
  run(backend, 'place', PLACE, PLACE_WANT)
  run(backend, 'records', RECORDS, RECORDS_WANT)
}

console.log(`\nmeaning-native: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
