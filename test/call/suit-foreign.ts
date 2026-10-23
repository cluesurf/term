// Gap 110 of note/project/term/guides/research/gaps/plan.md (term-compiler-0004): `suit` wears a mask for a form another
// PACKAGE declares, with the mask from a third package, as a real project with two `link/` packages built by the CLI.
// The form `tile` is in @fixture/shape, the mask `sizer` in @fixture/sizer, and the app suits one to the other and calls
// the method through a bounded generic. Held: the one-unit-at-a-time build, the merged build, the test on node and on
// every native toolchain present, and a suit whose worn task does not fit the foreign mask is refused.
//
// Run: npx tsx test/call/suit-foreign.ts (after `pnpm run make:line`)

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const LINE = process.env.TERM_LINE ?? join(HERE, '../../host/line.js')

let pass = 0
let fail = 0

function ok(name: string, good: boolean, detail = ''): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function term(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const run = spawnSync('node', [LINE, ...args], { cwd, encoding: 'utf8', timeout: 600_000, env: { ...process.env, NO_COLOR: '1' } })

  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

function has(tool: string): boolean {
  return spawnSync('which', [tool]).status === 0
}

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

const SHAPE = `form tile
  link side, like number

task make-tile
  take side, like number
  like tile
  send back
    make tile
      bind side, read side
`

const SIZER = `mask sizer
  task size-of
    take self
    like number
`

function app(worn: string): string {
  return `load @fixture/shape
  find tile
  find make-tile

load @fixture/sizer
  find sizer

suit tile
  wear sizer
    task size-of
${worn}

task describe
  head t
    need sizer
  take x, like t
  like number
  send back
    call size-of
      read x
`
}

const FITS = `      take self
      like number
      send back
        call multiply
          read self/side
          read self/side`

const MISFITS = `      take self
      like text
      send back, text <wide>`

const TEST = `load @fixture/shape
  find tile
  find make-tile

load @fixture/sizer
  find sizer

load @/base
  find describe

test a-suit-for-a-foreign-form-dispatches
  save b, call make-tile(code 4)
  want hold
    call is-equal
      call describe(read b)
      code 16
`

function project(worn: string): string {
  const root = mkdtempSync(join(tmpdir(), 'term-suit-foreign-'))
  write(root, 'deck.tree', 'deck @fixture/app\n  mark <0.0.2>\n  link @fixture/shape, mark <0.0.x>\n  link @fixture/sizer, mark <0.0.x>\n')
  write(root, 'link/@fixture/shape/deck.tree', 'deck @fixture/shape\n  mark <0.0.2>\n')
  write(root, 'link/@fixture/shape/code/base.tree', SHAPE)
  write(root, 'link/@fixture/sizer/deck.tree', 'deck @fixture/sizer\n  mark <0.0.2>\n')
  write(root, 'link/@fixture/sizer/code/base.tree', SIZER)
  write(root, 'code/base.tree', app(worn))
  write(root, 'test/base.tree', TEST)

  return root
}

{
  const root = project(FITS)

  const separate = term(root, 'make')
  ok('a suit for a form of another package builds one unit at a time', separate.status === 0, separate.out)

  const merged = term(root, 'make', '--merged')
  ok('and merged', merged.status === 0, merged.out)

  const node = term(root, 'test')
  ok('and its method answers through a bounded generic on node', node.status === 0 && /1 passed/.test(node.out), node.out)

  for (const [env, tool] of [['rust', 'cargo'], ['swift', 'swiftc'], ['kotlin', 'kotlinc']] as const) {
    if (!has(tool)) {
      console.log(`skip  on ${env}: no ${tool}`)
      continue
    }

    const native = term(root, 'test', '--env', env)
    ok(`and on ${env}`, native.status === 0 && /1 passed/.test(native.out), native.out)
  }
}

{
  // the foreign mask's signature reaches the app's suit: a worn task answering text where the mask says number
  const root = project(MISFITS)
  const built = term(root, 'make')
  ok(
    'a suit whose task does not fit the foreign mask is refused',
    built.status !== 0 && /answers number, and this one\s+answers text/.test(built.out),
    built.out,
  )
}

console.log(`\nsuit-foreign: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
