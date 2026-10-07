// The raise sets with and without the checkedDivision predicate (decisions-2026-10 divisor-0001, spec.md section 3.1).
// An integer `/` or `%` the predicate marks adds `defect` to its task, by name, and the callers inherit it. A guarded
// division, a float division and a division the predicate refuses add nothing. Without a predicate nothing changes.
// Both live copies are held to the same answers (check/effects.ts and effects.tree through its port, traps T002).
// Run: sh tmp/dec-tsx.sh test/check/divisor-raise.ts

import type { Expression, Program } from '@term/make/code/compile/node'
import { compile } from '@term/make/code/compile/compile'
import { raiseSetsOf as raiseSetsOfTypeScript } from '@term/make/code/check/effects'
import { raiseSetsOf as raiseSetsOfTerm } from '../../deck/make/host/port/code/check/effects'

type Predicate = (node: Expression) => boolean
type Sets = { raises: Map<string, string[]> }
type Copy = { name: string; raiseSetsOf: (program: Program, exceptions: string[], check?: Predicate) => Sets }

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

const SOURCE = `task share
  take total, like number
  take parts, like number
  like number
  send back
    call divide
      read total
      read parts

task caller
  take total, like number
  take parts, like number
  like number
  send back
    call share
      read total
      read parts

task rest
  take total, like number
  take parts, like number
  like number
  send back
    call modulo
      read total
      read parts

task rest-caller
  take total, like number
  take parts, like number
  like number
  send back
    call rest
      read total
      read parts

task guarded
  take total, like number
  take parts, like number
  like number
  fork
    mark unsafe
    save got
      call divide
        read total
        read parts
    send back, read got
  halt take
    take problem
    send back, code 0

task guarded-caller
  take total, like number
  take parts, like number
  like number
  send back
    call guarded
      read total
      read parts

task ratio
  take left, like float
  take right, like float
  like float
  send back
    call divide
      read left
      read right

task plain
  take total, like number
  like number
  send back
    call add
      read total
      code 1

task closing
  take total, like number
  take parts, like number
  like task
    like number
  send back
    task
      like number
      send back
        call divide
          read total
          read parts
`

const built = compile({ file: 'divisor.tree', text: SOURCE }, { optimize: false })

if (!built.ok) {
  console.log(`FAIL  the program did not build: ${built.diagnostics.map(d => d.message).join(' | ')}`)
  process.exit(1)
}

const program = built.program

function show(set: string[] | undefined): string {
  return set === undefined ? 'absent' : `[${set.join(', ')}]`
}

function has(sets: Sets, task: string): boolean {
  return (sets.raises.get(task) ?? []).includes('defect')
}

const copies: Copy[] = [
  { name: 'effects.ts', raiseSetsOf: raiseSetsOfTypeScript as Copy['raiseSetsOf'] },
  { name: 'effects.tree', raiseSetsOf: raiseSetsOfTerm as unknown as Copy['raiseSetsOf'] },
]

for (const copy of copies) {
  const label = (what: string): string => `${copy.name}: ${what}`

  // (a) no predicate: nothing raises on account of a division
  const none = copy.raiseSetsOf(program, [])
  ok(label('(a) no predicate, share raises nothing'), (none.raises.get('share') ?? []).length === 0, show(none.raises.get('share')))
  ok(label('(a) no predicate, no task raises defect'), [...none.raises.keys()].every(task => !has(none, task)))

  // (b) a predicate answering true for every division: share and its caller raise defect
  let asked = 0
  const seen: string[] = []
  const every: Predicate = node => {
    asked++
    seen.push(String((node as unknown as { op: string }).op))

    return true
  }
  const all = copy.raiseSetsOf(program, [], every)
  console.log(`      ${copy.name} (b) share ${show(all.raises.get('share'))}, caller ${show(all.raises.get('caller'))}, rest ${show(all.raises.get('rest'))}`)
  ok(label('(b) share raises defect'), has(all, 'share'), show(all.raises.get('share')))
  ok(label('(b) the caller of share raises defect'), has(all, 'caller'), show(all.raises.get('caller')))
  ok(label('(b) the predicate is asked of / and % nodes only'), asked > 0 && seen.every(op => op === '/' || op === '%'), `asked ${asked}: ${seen.join(' ')}`)

  // (c) the same division inside a guard: the guarded task raises nothing, and so its caller
  ok(label('(c) a guarded division adds nothing'), !has(all, 'guarded'), show(all.raises.get('guarded')))
  ok(label('(c) a caller of a guarded division adds nothing'), !has(all, 'guarded-caller'), show(all.raises.get('guarded-caller')))

  // (d) a float division: the predicate says no, as the emitters' own test does, and the answer is nothing
  const integersOnly: Predicate = node => {
    const given = node as unknown as { left: { type?: { kind?: string } } }

    return given.left.type?.kind !== 'float'
  }
  const floats = copy.raiseSetsOf(program, [], integersOnly)
  ok(label('(d) a float division raises nothing'), !has(floats, 'ratio'), show(floats.raises.get('ratio')))
  ok(label('(d) the integer one beside it still raises defect'), has(floats, 'share'), show(floats.raises.get('share')))

  // (e) a predicate answering false: nothing
  const refused = copy.raiseSetsOf(program, [], () => false)
  ok(label('(e) a predicate answering false adds nothing'), [...refused.raises.keys()].every(task => !has(refused, task)))

  // (f) a remainder like a division
  ok(label('(f) rest raises defect'), has(all, 'rest'), show(all.raises.get('rest')))
  ok(label('(f) the caller of rest raises defect'), has(all, 'rest-caller'), show(all.raises.get('rest-caller')))

  // a task with no division stays out
  ok(label('a task with no division raises nothing'), !has(all, 'plain'), show(all.raises.get('plain')))

  // a division in a closure is its maker's
  ok(label('a division inside a closure raises on its maker'), has(all, 'closing'), show(all.raises.get('closing')))

  // defect is added by name: a program holding no `defect` form still gets it in the set
  ok(label('defect is added by name, the program holds no such form'), has(all, 'share') && !program.some(s => s.form === 'record-type' && s.name === 'defect'))
}

// the two copies answer the same for every task
{
  const left = raiseSetsOfTypeScript(program, [], () => true).raises
  const right = (raiseSetsOfTerm as unknown as Copy['raiseSetsOf'])(program, [], () => true).raises
  const names = [...new Set([...left.keys(), ...right.keys()])].sort()
  const differ = names.filter(name => [...(left.get(name) ?? [])].sort().join() !== [...(right.get(name) ?? [])].sort().join())
  ok('the two copies answer the same for every task', differ.length === 0, differ.map(name => `${name}: ${show(left.get(name))} vs ${show(right.get(name))}`).join(' | '))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
