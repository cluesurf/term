// Rust emitter shapes of a sift arm's fields the CLI's entry refused after 1094 (finding/native-entry.md of
// term/self-host/change/001-finish-self-host), each its own program, held through rustc and RUN, against TypeScript's
// answer:
//   - shared-label-borrowed-arm (item term-self-host-001-1099): compile/backend-copies.tree borrowed-records read an
//     arm's field types by its bare case label, so where another form has a case of the same name (`token`'s `word`
//     below, node.tree's `form`, `text`, `word` beside minted's), the arm's record fields read as that form's scalars,
//     a bare read of one kept the parameter `&R`, and the arm handed the reference on (E0308 expected `Maybe<i64>`,
//     found `&Maybe<i64>`, 22 sites: origin_of's FindOrigin, node_of, written_at, empty_annotation)
//   - shared-label-list-field (item term-self-host-001-1100): compile/backend-lending.tree owned-fields read an arm's
//     fields by its bare case label, so where a later form has a case of the same name (`value`'s `list` below,
//     host-value's beside feed-rule's and mine-rule's), the arm's locals were that form's fields, the list field the
//     arm handed to a task taking the shared list was never seen, and it stayed a plain `Vec` (E0308 expected
//     `Rc<RefCell<Vec<FeedRule>>>`, found `Vec<FeedRule>`, gather_codes, rule_children, match_rule)
// Run: npx tsx test/compile/rust-arm-fields.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

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

// `word` and `other` are cases of both `held` and `token`; `token`'s, written later, hold no record
const sharedLabelBorrowedArm = `load @term/base/maybe
  find maybe

form spot
  link name, like text
  link size, like number

form held
  case word
    link word-name, like text
    link word-spot, like maybe, like spot
    link word-at, like maybe, like number
  case other
    link other-name, like text
    link other-spot, like maybe, like spot
    link other-at, like maybe, like number

form token
  case word
    link word-text, like text
    link word-size, like number
    link word-count, like number
  case other
    link other-text, like text

form origin
  link spot, like maybe, like spot
  link at, like maybe, like number

task spot-of
  take value, like held
  like maybe, like spot
  sift value
    case word
      link word-name
      link word-spot
      back word-spot
    case other
      link other-name
      link other-spot
      back other-spot

task origin-of
  take value, like held
  like origin
  sift value
    case word
      link word-name
      link word-spot
      link word-at
      back make(origin, bind(spot, word-spot), bind(at, word-at))
    miss
      back make(origin, bind(spot, make none), bind(at, make none))

task size-in
  take found, like maybe, like spot
  like number
  sift found
    case some
      link spot
      back spot/size
    case none
      back 0

task at-in
  take found, like maybe, like number
  like number
  sift found
    case some
      link at
      back at
    case none
      back 0

task handed
  take at, like number
  like number
  save one, make(word, bind(word-name, <w>), bind(word-spot, make(some, make(spot, bind(name, <s>), bind(size, at)))), bind(word-at, make(some, 7)))
  save origin, origin-of(one)
  back add(add(size-in(spot-of(one)), size-in(origin/spot)), at-in(origin/at))
`

// `list` is a case of both `rule` and `value`; `value`'s, written later, holds no `children`
const sharedLabelListField = `load @term/base/list
  find push

form rule
  case list
    link children, like list, like rule
    link count, like number
  case any
    link children, like list, like rule
    link send, like text
  case char
    link literal, like number

form value
  case list
    link items, like list, like number
  case word
    link text, like text

task gather-codes
  take rules, like list, like rule
  take codes, like list, like number

  walk rules
    take rule
    sift rule
      case char
        push(codes, literal)
      case any
        gather-codes(children, codes)
      case list
        gather-codes(children, codes)
      miss
        save nothing, 0

task rule-children
  take rule, like rule
  like list, like rule

  sift rule
    case list
      back children
    case any
      back children
    miss
      back make list

task char-list
  take at, like number
  like list, like rule
  save inner, make list
  push(inner, make(char, bind(literal, at)))
  back inner

task gathered
  take at, like number
  like number
  save some, make list
  push(some, make(list, bind(children, char-list(at)), bind(count, 1)))
  push(some, make(any, bind(children, char-list(add(at, 1))), bind(send, <s>)))
  save codes, make list
  gather-codes(some, codes)
  save kids, rule-children(get(some, 0))
  back add(add(codes/length, kids/length), add(get(codes, 0), get(codes, 1)))
`

interface Case {
  name: string
  text: string
  entries: string[]
  calls: [string, number][]
  want: string
  pattern: RegExp
  code: string
}

const cases: Case[] = [
  // handed(3) is 3 + 3 + 7
  { name: 'shared-label-borrowed-arm', text: sharedLabelBorrowedArm, entries: ['handed'], calls: [['handed', 3]], want: '13', pattern: /fn (spot|origin)_of\(value: &Held\)/, code: 'E0308' },
  // gathered(3) is (2 + 1) + (3 + 4)
  { name: 'shared-label-list-field', text: sharedLabelListField, entries: ['gathered'], calls: [['gathered', 3]], want: '10', pattern: /List \{ children: Vec<Rule>/, code: 'E0308' },
]

const camel = (snake: string): string => snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())

for (const c of cases) {
  const file = `/gate/code/${c.name}.tree`
  const leanOf = (f: string): boolean => f === file
  const node = compile({ file, text: c.text }, { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: c.entries })
  if (!node.ok) {
    ok(`${c.name}: the program builds for node`, false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-arm-fields-'))
    const out = join(dir, 'module.mjs')
    writeFileSync(out, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
    const mod = (await import(pathToFileURL(out).href)) as Record<string, (n: number) => number>
    const answer = c.calls.map(([task, n]) => mod[camel(task)]!(n)).join('|')
    ok(`${c.name}: TypeScript answers`, answer === c.want, answer)
  }

  const built = compile({ file, text: c.text }, { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf, entryPoints: c.entries })
  if (!built.ok) {
    ok(`${c.name}: the program builds for rust`, false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
    continue
  }
  const emitted = emitRust(built.program)
  ok(`${c.name}: the emitted shape is gone`, !c.pattern.test(emitted), (emitted.match(c.pattern) ?? [''])[0])
  const unwrapOf = (task: string): string => (new RegExp(`fn ${task}\\([^)]*\\) -> std::result::Result`).test(emitted) ? '.ok().unwrap()' : '')
  const prints = c.calls.map(([task, n]) => `${task}(${n})${unwrapOf(task)}`).join(', ')
  const rust = `${emitted}\nfn main() {\n    print!("${c.calls.map(() => '{}').join('|')}", ${prints});\n}\n`
  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })
  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
    continue
  }
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-arm-fields-'))
  writeFileSync(join(dir, 'main.rs'), rust)
  const binary = join(dir, 'main')
  const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
  const errors = out.stderr.split('\n').filter(l => /^error/.test(l))
  ok(`${c.name}: rustc compiles it`, out.status === 0, errors.join(' | '))
  ok(`${c.name}: no ${c.code}`, !errors.some(l => l.includes(c.code)), errors.filter(l => l.includes(c.code)).join(' | '))
  if (out.status === 0) {
    const ran = spawnSync(binary, [], { encoding: 'utf8' })
    ok(`${c.name}: Rust answers what TypeScript does`, ran.stdout.trim() === c.want, ran.stdout.trim())
  }
}

console.log(`\nrust-arm-fields: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
