// A native program written one file per Term module (compile/unit-split.ts, emit-target.ts `emitTargetUnits`,
// note/term/plan/incremental-best-in-class.md, step 15). Every representation is still decided over the whole program;
// each module's statements go in a file of their own beside a shared one. Held here: the split program builds and
// answers exactly what the one file answers, on rustc, swiftc and kotlinc (each skipped when absent); and a body edit
// to one module changes that module's file and no other, which is what lets the toolchain's own incremental build redo
// one file's work.
// Run: npx tsx test/compile/native-units.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitTarget, emitTargetUnits } from '@term/make/code/compile/emit-target'
import type { UnitFiles } from '@term/make/code/compile/emit-target'
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

const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
const have = (tool: string): boolean => spawnSync('which', [tool], { encoding: 'utf8' }).status === 0

const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-units-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/units\n  mark <0.0.2>\n`)

const SHAPE = `form shape
  case square
    link side, like number
  case strip
    link long, like number
    link wide, like number

task area
  take of, like shape
  like number
  sift of
    case square
      back multiply(side, side)
    case strip
      back multiply(long, wide)
`
const count = (body: string): string => `task total
  take n, like number
  like number
${body}`
const COUNT = count(`  fork test
    hook test, is-maximum(n, 0)
    hook hold
      back 0
  back add(n, total(subtract(n, 1)))
`)
// the same answer by another body: only the module's own file may change
const COUNT_EDITED = count(`  save sum, 0
  save at, 1
  walk test
    hook test, is-maximum(at, n)
    hook hold
      save sum, add(sum, at)
      save at, add(at, 1)
  back sum
`)
const ENTRY = `load ./shape
  find shape
  find square
  find strip
  find area
load ./count
  find total

task run
  like text
  save small
    make square
      bind side, 4
  save long
    make strip
      bind long, 2
      bind wide, 3
  back <{total(10)} {area(small)} {area(long)}>
`

writeFileSync(join(root, 'code', 'shape.tree'), SHAPE)
writeFileSync(join(root, 'code', 'count.tree'), COUNT)
writeFileSync(join(root, 'code', 'base.tree'), ENTRY)

type Native = 'rust' | 'swift' | 'kotlin'

const built = (target: Native, text: string): ReturnType<typeof compile> =>
  compile({ file: join(root, 'code', 'base.tree'), text }, { resolve: projectResolver(root, target), env: target })

// the program for a target, as one file and as files
const emitBoth = (target: Native, text = ENTRY): { one: string; units: UnitFiles } | undefined => {
  const result = built(target, text)

  if (!result.ok) {
    console.log(`  ${target} did not compile: ${result.diagnostics.map(d => d.message).slice(0, 3).join(' | ')}`)

    return undefined
  }

  return {
    one: emitTarget({ program: result.program, typescript: result.typescript, target, readRuntime }),
    units: emitTargetUnits({ program: result.program, target, readRuntime }),
  }
}

// ---- the split: every module's statements in a file of their own ----

for (const target of ['rust', 'swift', 'kotlin'] as const) {
  const both = emitBoth(target)

  if (!both) {
    ok(`${target}: the program compiles`, false)
    continue
  }

  const names = both.units.files.map(([name]) => name)
  ok(`${target}: one file per module beside the shared one`, names.length === 4 && names.includes(both.units.main), names.join(', '))
  ok(
    `${target}: the shared file holds no module's statement`,
    !/\btotal\b|\barea\b/.test(both.units.files.find(([name]) => name === both.units.main)![1].replace(/include!\("[^"]*"\);/g, '')),
  )
  ok(`${target}: and no mark is left in any file`, both.units.files.every(([, text]) => !/[-]/.test(text)) && !/[-]/.test(both.one))
}

// ---- the edit: one module's body, one file ----

const before = new Map(['rust', 'swift', 'kotlin'].map(target => [target, emitBoth(target as Native)?.units]))
writeFileSync(join(root, 'code', 'count.tree'), COUNT_EDITED)
const after = new Map(['rust', 'swift', 'kotlin'].map(target => [target, emitBoth(target as Native)?.units]))

for (const target of ['rust', 'swift', 'kotlin']) {
  const a = new Map(before.get(target)?.files ?? [])
  const b = new Map(after.get(target)?.files ?? [])
  const changed = [...b.keys()].filter(name => a.get(name) !== b.get(name))

  ok(`${target}: a body edit to count.tree rewrites one file, count's`, changed.length === 1 && /count/.test(changed[0] ?? ''), changed.join(', ') || 'none')
}

writeFileSync(join(root, 'code', 'count.tree'), COUNT)

// ---- the split program answers what the one file answers ----

const out = join(root, 'out')
mkdirSync(out, { recursive: true })

// a toolchain run, answering its errors when it fails
const tool = (args: string[], cwd: string): string | undefined => {
  try {
    execFileSync(args[0]!, args.slice(1), { stdio: 'pipe', cwd })

    return undefined
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 1200)
  }
}

const runs = (command: string[], cwd: string): string => spawnSync(command[0]!, command.slice(1), { encoding: 'utf8', cwd }).stdout

// the answer of each form of the program on one toolchain: the one file, then the files
const answers = (target: Native, text = ENTRY, label = 'small'): [string, string] | string => {
  const both = emitBoth(target, text)

  if (!both) {
    return `${target} did not compile`
  }

  const one = join(out, `${target}-${label}-one`)
  const split = join(out, `${target}-${label}-split`)
  mkdirSync(one, { recursive: true })
  mkdirSync(split, { recursive: true })

  if (target === 'rust') {
    const raises = /fn run\(\) -> std::result::Result/.test(both.one)
    const main = `fn main() { print!("{}", run()${raises ? '.unwrap()' : ''}); }\n`
    writeFileSync(join(one, 'main.rs'), `${both.one}\n${main}`)
    both.units.files.forEach(([name, text]) => writeFileSync(join(split, name), name === 'main.rs' ? `${text}\n${main}` : text))

    const failed = tool(['rustc', '--edition', '2021', '-A', 'warnings', '-o', 'one', 'main.rs'], one) ?? tool(['rustc', '--edition', '2021', '-A', 'warnings', '-o', 'split', 'main.rs'], split)

    return failed ?? [runs([join(one, 'one')], one), runs([join(split, 'split')], split)]
  }

  if (target === 'swift') {
    const raises = /func run\(\) throws/.test(both.one)
    const main = `print(${raises ? 'try ' : ''}run(), terminator: "")\n`
    writeFileSync(join(one, 'main.swift'), `import Foundation\n${both.one}\n${main}`)
    both.units.files.forEach(([name, text]) => writeFileSync(join(split, name), text))
    writeFileSync(join(split, 'main.swift'), `import Foundation\n${main}`)

    const failed =
      tool(['swiftc', '-o', 'one', 'main.swift'], one) ?? tool(['swiftc', '-o', 'split', 'main.swift', ...both.units.files.map(([name]) => name)], split)

    return failed ?? [runs([join(one, 'one')], one), runs([join(split, 'split')], split)]
  }

  const main = 'fun main() { print(run()) }\n'
  writeFileSync(join(one, 'Main.kt'), `${both.one}\n${main}`)
  both.units.files.forEach(([name, text]) => writeFileSync(join(split, name), text))
  writeFileSync(join(split, 'Main.kt'), main)

  const failed =
    tool(['kotlinc', 'Main.kt', '-include-runtime', '-nowarn', '-d', 'one.jar'], one) ??
    tool(['kotlinc', 'Main.kt', ...both.units.files.map(([name]) => name), '-include-runtime', '-nowarn', '-d', 'split.jar'], split)

  return failed ?? [runs(['java', '-jar', 'one.jar'], one), runs(['java', '-jar', 'split.jar'], split)]
}

for (const [target, needs] of [['rust', ['rustc']], ['swift', ['swiftc']], ['kotlin', ['kotlinc', 'java']]] as const) {
  if (!needs.every(have)) {
    console.log(`skip  ${target}: ${needs.join(', ')} not installed`)
    continue
  }

  const answer = answers(target)

  if (typeof answer === 'string') {
    ok(`${target}: both forms build`, false, answer)
    continue
  }

  ok(`${target}: the files answer what the one file answers`, answer[0] === answer[1] && answer[0] === '55 16 6', JSON.stringify(answer))
}

// ---- a program of many standard library modules: generics, the text runtime, lists, sorting ----

const WIDE = `load @term/base/text
  find trim
  find to-upper-case
  find split
  find char-count
load @term/base/list
  find sort-by

task size-of
  take word, like text
  like number
  back char-count(word)

task run
  like text
  save words, split(trim(<  pear fig banana kiwi  >), < >)
  save sorted, sort-by(words, size-of)
  save out, <>
  walk list, read sorted
    hook next
      take site, name word
      save out, <{out}{to-upper-case(word)},>
  back out
`

writeFileSync(join(root, 'code', 'base.tree'), WIDE)

for (const [target, needs] of [['rust', ['rustc']], ['swift', ['swiftc']], ['kotlin', ['kotlinc', 'java']]] as const) {
  if (!needs.every(have)) {
    continue
  }

  const units = emitBoth(target, WIDE)?.units
  ok(`${target}: the wide program is cut into a file per module`, (units?.files.length ?? 0) > 3, String(units?.files.length))

  const answer = answers(target, WIDE, 'wide')

  if (typeof answer === 'string') {
    ok(`${target}: the wide program builds in both forms`, false, answer)
    continue
  }

  ok(`${target}: and its files answer what its one file answers`, answer[0] === answer[1] && answer[0] === 'FIG,PEAR,KIWI,BANANA,', JSON.stringify(answer))
}

console.log(`\nnative-units: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
