// The emit manifest (item term-self-host-001-0037): every corpus module's emitted text per target as a digest, and a diff
// of two such manifests. The first half of the fixpoint (term:fixpoint, item 0170).
//
//   sh tmp/run-term.sh npx tsx task/term/emit-manifest.ts --out <file> [--targets ts,rust,swift,kotlin]
//     [--sample N --seed S] [--replace yes]
//   sh tmp/run-term.sh npx tsx task/term/emit-manifest.ts --diff <a> <b>
//
// A manifest line is `<module> <target> <sha256 of the emitted text>`, in module then target order, over the corpus of
// shared-nodes.ts (pair-intervals' input builder: checked files of the decks and tests, the mark benchmarks, random
// files), each module compiled whole as a library with its deck's resolver, role and lean rules. `ts` is
// `compile(...).typescript`. `rust`, `swift` and `kotlin` are the program `compile` answers for that target, emitted by
// its backend with the runtime prelude it asks for (as call/code/test-native.ts builds a native test).
// A module that does not build for a target is a line whose digest is `failed-<sha256 of the first message>`, so a
// message that changes counts as a change and a failure is never mistaken for an equal text.
//
// Beside the manifest `--out` also writes the texts it digested, gzipped, to `<file>.text/<target>/<module>.gz`, since a
// digest cannot say WHERE two texts differ. `--diff` prints the count of changed modules per target and every changed
// module's path (a module only one side holds counts as changed), and writes the first differing hunk of each (20 lines
// at most) to `<term>/tmp/self-host/emit-diff/<module with / as __>.<target>.diff`. Run from the Term root.
//
// Exit 0 once written; --diff exits 0 whether or not anything changed (the verdict is the count); 2 on usage.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import type { Program } from '@term/make/code/compile/node'
import { build, corpus } from './shared-nodes'
import type { Unit } from './shared-nodes'

const TARGETS = ['ts', 'rust', 'swift', 'kotlin']
const USAGE =
  'usage: emit-manifest.ts --out <file> [--targets ts,rust,swift,kotlin] [--sample N --seed S] [--replace yes] | --diff <a> <b>'

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

// ---- emitting ----

const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

// one module for a native backend, as call/code/test-native.ts builds one: the program `compile` answers for the target,
// emitted by the backend, with the runtime prelude it asks for
function emitNative(unit: Unit, env: 'rust' | 'swift' | 'kotlin'): { text?: string; reason?: string } {
  const built = build(unit, true, env)
  if (!built.program) return { reason: built.reason ?? 'no program' }
  try {
    const program = built.program as Program
    const emitted = env === 'rust' ? emitRust(program) : env === 'swift' ? emitSwift(program) : emitKotlin(program)
    const prelude = nativePrelude(program, env, readRuntime, emitted)
    return { text: env === 'kotlin' ? hoistKotlinImports(`${prelude}\n${emitted}`) : `${prelude}\n${emitted}` }
  } catch (error) {
    return { reason: `threw ${(error as Error).message.split('\n')[0]}` }
  }
}

function emitFor(unit: Unit, target: string): { text?: string; reason?: string } {
  if (target === 'ts') {
    const built = build(unit, true)
    return built.typescript === undefined ? { reason: built.reason ?? 'no typescript' } : { text: built.typescript }
  }
  return emitNative(unit, target as 'rust' | 'swift' | 'kotlin')
}

// ---- writing ----

function textPath(out: string, target: string, module: string): string {
  return join(`${out}.text`, target, `${module.replaceAll('/', '__')}.gz`)
}

function write(out: string, targets: string[], units: Unit[]): void {
  const lines: string[] = []
  const reasons = new Map<string, number>()
  const counts = new Map<string, { built: number; failed: number }>(targets.map(t => [t, { built: 0, failed: 0 }]))
  for (const unit of units) {
    for (const target of targets) {
      const emitted = emitFor(unit, target)
      const count = counts.get(target)!
      let digest: string
      let kept: string
      if (emitted.text !== undefined) {
        digest = sha(emitted.text)
        kept = emitted.text
        count.built++
      } else {
        kept = `failed: ${emitted.reason}`
        digest = `failed-${sha(kept)}`
        count.failed++
        const why = kept.slice(0, 110)
        reasons.set(`${target}: ${why}`, (reasons.get(`${target}: ${why}`) ?? 0) + 1)
      }
      lines.push(`${unit.file} ${target} ${digest}`)
      const path = textPath(out, target, unit.file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, gzipSync(kept))
    }
  }
  mkdirSync(dirname(resolvePath(out)), { recursive: true })
  writeFileSync(out, `${lines.join('\n')}\n`)
  console.log(`EMIT-MANIFEST ${out}`)
  console.log(`modules:  ${units.length}`)
  for (const target of targets) {
    const count = counts.get(target)!
    console.log(`${target.padEnd(7)} ${count.built} emitted, ${count.failed} failed to build`)
  }
  console.log(`lines:    ${lines.length}`)
  for (const [why, count] of [...reasons].sort((x, y) => y[1] - x[1]).slice(0, 3)) console.log(`  failed ${count}x ${why}`)
  console.log('status: PASS')
}

// ---- diffing ----

function read(file: string): Map<string, string> {
  const rows = new Map<string, string>()
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    const [module, target, digest] = line.split(' ')
    if (!module || !target || !digest) usage(`bad manifest line in ${file}: ${line}`)
    rows.set(`${module} ${target}`, digest)
  }
  return rows
}

function kept(file: string, target: string, module: string): string | undefined {
  const path = textPath(file, target, module)
  return existsSync(path) ? gunzipSync(readFileSync(path)).toString('utf8') : undefined
}

// the first differing hunk, 20 lines at most: a header, up to 3 lines of context, then the two sides
function hunk(a: string | undefined, b: string | undefined, names: [string, string]): string {
  if (a === undefined || b === undefined) {
    return `--- ${names[0]}\n+++ ${names[1]}\n@@ the text of ${a === undefined ? names[0] : names[1]} was not kept beside its manifest @@\n`
  }
  const left = a.split('\n')
  const right = b.split('\n')
  let at = 0
  while (at < left.length && at < right.length && left[at] === right[at]) at++
  const out = [`--- ${names[0]}`, `+++ ${names[1]}`, `@@ first difference at line ${at + 1} @@`]
  const room = 20 - out.length
  const before = Math.min(3, at, room)
  for (let i = at - before; i < at; i++) out.push(` ${left[i]}`)
  // the differing span ends where the two texts agree again to their ends (the common suffix)
  let suffix = 0
  while (suffix < left.length - at && suffix < right.length - at && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++
  const gone = left.slice(at, left.length - suffix)
  const came = right.slice(at, right.length - suffix)
  const budget = room - before
  const removed = Math.min(gone.length, Math.max(Math.ceil(budget / 2), budget - came.length))
  const added = Math.min(came.length, budget - removed)
  for (let i = 0; i < removed; i++) out.push(`-${gone[i]}`)
  for (let i = 0; i < added; i++) out.push(`+${came[i]}`)
  return `${out.slice(0, 20).join('\n')}\n`
}

function diff(aFile: string, bFile: string): void {
  const a = read(aFile)
  const b = read(bFile)
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort()
  const changed = new Map<string, string[]>()
  const compared = new Map<string, number>()
  const dir = join('tmp', 'self-host', 'emit-diff')
  mkdirSync(dir, { recursive: true })
  for (const key of keys) {
    const [module, target] = key.split(' ') as [string, string]
    compared.set(target, (compared.get(target) ?? 0) + 1)
    if (a.get(key) === b.get(key)) continue
    if (!changed.has(target)) changed.set(target, [])
    changed.get(target)!.push(module)
    writeFileSync(join(dir, `${module.replaceAll('/', '__')}.${target}.diff`), hunk(kept(aFile, target, module), kept(bFile, target, module), [aFile, bFile]))
  }
  console.log(`EMIT-DIFF ${aFile} ${bFile}`)
  let total = 0
  for (const target of [...compared.keys()].sort()) {
    const modules = changed.get(target) ?? []
    total += modules.length
    console.log(`${target}: ${modules.length} changed of ${compared.get(target)}`)
    for (const module of modules) console.log(`  ${module}`)
  }
  console.log(`changed: ${total}${total > 0 ? `, first hunks in ${dir}` : ''}`)
  console.log(`status: ${total === 0 ? 'PASS' : 'DIFFERENT'}`)
}

// ---- main ----

function main(): void {
  const argv = process.argv.slice(2)
  let out: string | undefined
  let targets = TARGETS
  let sample: number | undefined
  let seed = 9137
  let diffing: [string, string] | undefined
  let replace = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--diff') {
      const a = argv[i + 1]
      const b = argv[i + 2]
      if (!a || !b) usage('--diff needs two manifests')
      diffing = [a, b]
      i += 2
      continue
    }
    const value = argv[i + 1]
    if (value === undefined) usage(`${flag} needs a value`)
    if (flag === '--out') out = value
    else if (flag === '--replace') replace = value === 'yes'
    else if (flag === '--targets') targets = value.split(',').filter(Boolean)
    else if (flag === '--sample') sample = Number(value)
    else if (flag === '--seed') seed = Number(value)
    else usage(`unknown flag ${flag}`)
    i++
  }
  for (const target of targets) if (!TARGETS.includes(target)) usage(`unknown target ${target}`)
  if (sample !== undefined && !(sample > 0)) usage('--sample needs a positive number')
  if (!Number.isFinite(seed)) usage('--seed needs a number')
  if (diffing) return diff(diffing[0], diffing[1])
  if (!out) usage('--out or --diff is required')
  // a manifest is a reference copy (the fixpoint's witness): never overwritten unless asked outright
  if (existsSync(out) && !replace) usage(`${out} exists: a manifest is a reference copy, so it is never overwritten. Pick another name, or pass --replace yes`)
  write(out, targets, corpus({ sample, seed }))
}

main()
