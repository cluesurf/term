// D15's census (note/project/term/decisions-2026-10/decisions-2026-10.md): per package, how many tasks hold an integer `+`, `-` or `*`
// that the build cannot prove stays inside the safe integers, and how many such steps there are.
//
// Each is a place where TypeScript raises `excess` or `shortage` (`__termInt`), Kotlin throws, and Rust and Swift
// stop the process. Option a of D15 makes such a task a RAISING one on the native backends, so this count is the
// number of signatures it would change before the call graph spreads it to their callers.
//
// The answer is the emitters' own: `provenArithmetic` (compile/proven.ts) over the program the file builds to, the
// set every backend consults before writing a step unchecked. A step outside it is a checked step. Reports only.
//
// --divisions (decisions-2026-10 divisor-0002) counts the other half of D15: the integer `/` and `%` the emitters write
// checked, which Swift and Rust will answer by raising `defect`. Per package: the divisions, how many the interval
// facts prove (the emitters' notion, `provenArithmetic` over `listFacts`, never the checker's tier-0 verdict, traps
// T004), the tasks holding one it does not, and the tasks whose raise set gains `defect` once `raiseSetsOf` takes that
// predicate (the direct ones, and their callers through the call graph). `bind` is left out unless named, 3,091
// generated files with no arithmetic. `--list <package>` names each newly raising task.
//
//   pnpm term:step-census                 every package
//   pnpm term:step-census base call       the named ones
//   pnpm term:step-census --divisions     the division census
//   pnpm term:step-census --divisions --list base

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { provenArithmetic } from '@term/make/code/compile/proven'
import { gatedTasks, listFacts } from '@term/make/code/compile/backend'
import { raiseSetsOf } from '@term/make/code/check/effects'
import * as tsNames from '@term/make/code/compile/ts-names'
import type { Expression, Statement } from '@term/make/code/compile/node'
import { buildable, findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { carriesTests, readable } from '@term/call/code/test-preprocess'
import { TERM_ROOT, parentPaths } from './root'

// the pnpm script runs this from the Term root
const TERM = TERM_ROOT
const REPO = TERM_ROOT
const wanted = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const DIVISIONS = process.argv.includes('--divisions')
const listAt = process.argv.indexOf('--list')
const LIST = listAt >= 0 ? process.argv[listAt + 1] : undefined
const STEPS = new Set(['+', '-', '*'])
const OMITTED = DIVISIONS ? new Set(['bind']) : new Set<string>()

const roots = [
  ...readdirSync(path.join(TERM, 'deck'))
    .map(name => path.join(TERM, 'deck', name))
    .filter(dir => existsSync(path.join(dir, 'deck.tree'))),
  ...parentPaths('deck/zone'),
].filter(root => (wanted.length === 0 && !OMITTED.has(path.basename(root))) || wanted.includes(path.basename(root)))

// every integer `/` and `%` in a body, a closure's included (raise-set `markDivisions` does not enter a closure, but
// its maker takes what the closure raises, so the task holding it is the same one)
function divisionsIn(node: unknown, out: Expression[]): void {
  if (node === null || typeof node !== 'object') {
    return
  }

  if (Array.isArray(node)) {
    node.forEach(one => divisionsIn(one, out))

    return
  }

  const record = node as Record<string, unknown>

  if (record.form === 'binary' && (record.op === '/' || record.op === '%') && tsNames.integerDivision(record as never)) {
    out.push(record as unknown as Expression)
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'type' && key !== 'span' && key !== 'binding' && key !== 'result') {
      divisionsIn(value, out)
    }
  }
}

let allDivisions = 0
let allProvenDivisions = 0
let allDividing = 0
let allRaising = 0
let allDirect = 0
let allDivisionTasks = 0
let over = 0

const tested = (text: string): string => (carriesTests(text) ? readable(text).text : text)

// every integer step in a body, a closure's included, since a closure's step raises in the closure's caller
function stepsIn(node: unknown, out: Expression[]): void {
  if (node === null || typeof node !== 'object') {
    return
  }

  if (Array.isArray(node)) {
    node.forEach(one => stepsIn(one, out))

    return
  }

  const record = node as Record<string, unknown>

  if (
    record.form === 'binary' &&
    STEPS.has(record.op as string) &&
    (record.left as { type?: { kind?: string } } | undefined)?.type?.kind === 'number' &&
    (record.right as { type?: { kind?: string } } | undefined)?.type?.kind === 'number'
  ) {
    out.push(record as unknown as Expression)
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'type' && key !== 'span' && key !== 'binding') {
      stepsIn(value, out)
    }
  }
}

let allTasks = 0
let allStepping = 0
let allSteps = 0
let unread = 0

for (const root of roots) {
  const resolve = projectResolver(root)
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)
  let tasks = 0
  let stepping = 0
  let steps = 0
  let unbuilt = 0
  let divisions = 0
  let provenDivisions = 0
  let dividing = 0
  let raising = 0
  let direct = 0
  const rows: string[] = []
  // a package this cannot read is said to be unread, never counted as clean: `0 of 0` reads as a zero. A folder that
  // is not there is that; one with no `.tree` file is a TypeScript package (flow, scan, feed), which has no Term step
  if (!existsSync(root)) {
    console.log(`${path.basename(root)}: NOT READ, ${path.relative(REPO, root)} is not there`)
    unread++
    continue
  }

  const files = findTreeFiles(root)

  if (files.length === 0) {
    console.log(`${path.basename(root)}: no Term source (no .tree file), nothing to count`)
    continue
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const unit = buildable(file, text, roleOf(file))
    const result = compile({ file, text: tested('faults' in unit ? text : unit.text) }, { resolve, deckOf, roleOf, leanOf, env: 'node' })

    if (!result.ok) {
      unbuilt++
      continue
    }

    const program = result.program as Statement[]

    if (DIVISIONS) {
      const masks = new Set(program.flatMap(n => (n.form === 'mask' ? n.methods : [])))
      const { lend, fresh } = listFacts(program, gatedTasks(program, masks))
      const provenFacts = provenArithmetic(program, lend, fresh)
      const exceptions = program
        .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && Boolean(n.chain?.includes('exception')))
        .map(n => n.name)
      const before = raiseSetsOf(program, exceptions)
      const after = raiseSetsOf(program, exceptions, node => tsNames.integerDivision(node as never) && !provenFacts.has(node))

      for (const s of program) {
        if (s.form !== 'function' || s.span?.file !== file || s.body.length === 0) {
          continue
        }

        tasks++
        const found: Expression[] = []
        divisionsIn(s.body, found)
        const unproven = found.filter(node => !provenFacts.has(node)).length
        divisions += found.length
        provenDivisions += found.length - unproven

        if (unproven > 0) {
          dividing++
        }

        const gained = (after.raises.get(s.name) ?? []).includes('defect') && !(before.raises.get(s.name) ?? []).includes('defect')

        if (gained) {
          raising++
          const from = after.via.get(s.name)?.get('defect') ?? ''
          direct += from === '' ? 1 : 0
          rows.push(`  ${path.relative(REPO, file)}:${s.span?.start?.line ?? '?'} ${s.name} ${from === '' ? 'direct' : `through ${from}`}`)
        }
      }

      continue
    }

    const proven = provenArithmetic(program, new Map(), new Set())

    for (const s of program) {
      if (s.form !== 'function' || s.span?.file !== file || s.body.length === 0) {
        continue
      }

      tasks++
      const found: Expression[] = []
      stepsIn(s.body, found)
      const open = found.filter(step => !proven.has(step)).length

      if (open > 0) {
        stepping++
        steps += open
      }
    }
  }

  if (tasks === 0) {
    console.log(`${path.basename(root)}: NOT READ, ${files.length} files and no task with a body among the ${files.length - unbuilt} that built`)
    unread++
    continue
  }

  if (DIVISIONS) {
    allDivisions += divisions
    allProvenDivisions += provenDivisions
    allDividing += dividing
    allRaising += raising
    allDirect += direct
    allDivisionTasks += tasks
    const percent = (raising / tasks) * 100
    const flag = percent > 5 ? ' OVER 5%' : ''
    over += percent > 5 ? 1 : 0
    console.log(
      `${path.basename(root)}: ${divisions} integer divisions, ${provenDivisions} proven, ${divisions - provenDivisions} unproven in ${dividing} tasks; ${raising} of ${tasks} tasks become raising (${direct} direct, ${raising - direct} through a callee, ${percent.toFixed(2)}%)${flag}${unbuilt ? `, ${unbuilt} files did not build and are not counted` : ''}`,
    )

    if (LIST === path.basename(root)) {
      rows.forEach(row => console.log(row))
    }

    continue
  }

  allTasks += tasks
  allStepping += stepping
  allSteps += steps
  console.log(`${path.basename(root)}: ${stepping} of ${tasks} tasks hold an unproven step (${steps} steps)${unbuilt ? `, ${unbuilt} files did not build and are not counted` : ''}`)
}

if (DIVISIONS) {
  console.log(
    `\ndivision-census (emitter notion: provenArithmetic over listFacts): ${allDivisions} integer divisions, ${allProvenDivisions} proven, ${allDivisions - allProvenDivisions} unproven, ${allDividing} tasks hold an unproven one; ${allRaising} of ${allDivisionTasks} tasks become raising (${allDirect} direct)${over ? `, ${over} packages OVER 5%` : ''}${unread ? `, ${unread} packages NOT READ` : ''}`,
  )

  if (unread > 0) {
    process.exitCode = 1
  }

  process.exit(process.exitCode ?? 0)
}

console.log(`\nstep-census: ${allStepping} of ${allTasks} tasks, ${allSteps} unproven steps${unread ? `, ${unread} packages NOT READ` : ''}`)

if (unread > 0) {
  process.exitCode = 1
}
