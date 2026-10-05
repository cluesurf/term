// The statement-level inliner (ir/inline-statements.ts), held both ways: Towers' pop and push inlined into the move
// that calls them, and for every rule a task it must NOT inline, each one otherwise the shape it does. Then what
// `simplify` does with the names it answers: an inlined task that is no root is dropped, a root keeps its definition,
// and a compile that names no roots keeps them all.
// Run: npx tsx test/ir/inline-statements.ts

import { compile } from '@term/make/code/compile/compile'
import { inlineStatements } from '@term/make/code/ir/inline-statements'
import { simplify } from '@term/make/code/ir/simplify'
import type { Program, Statement } from '@term/make/code/compile/node'

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

// the checked program, before the simplifier
function checked(text: string): Program {
  const built = compile({ file: 'main.tree', text }, { optimize: false })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  return built.program
}

const fn = (program: Program, name: string) =>
  (program as Statement[]).find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === name)

// the names a task's body still calls directly
function callees(program: Program, owner: string): string[] {
  const found: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) return value.forEach(visit)
    const node = value as { form?: string; callee?: { form?: string; name?: string } }
    if (node.form === 'call' && node.callee?.form === 'variable') found.push(node.callee.name!)
    for (const [key, child] of Object.entries(node)) if (key !== 'type' && key !== 'span') visit(child)
  }

  visit(fn(program, owner)?.body)

  return found
}

// every node of a form in a task's body
function nodes(program: Program, owner: string, form: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) return value.forEach(visit)
    const node = value as Record<string, unknown>
    if (node.form === form) found.push(node)
    for (const [key, child] of Object.entries(node)) if (key !== 'type' && key !== 'span') visit(child)
  }

  visit(fn(program, owner)?.body)

  return found
}

const STACK = `form stack
  case empty
  case disk
    link size, like number
    link below, like stack
`

const PUSH = `task push-disk
  take piles, like list, like stack
  take size, like number
  take pile, like number
  host top, read piles/{pile}
  save piles/{pile}
    make disk
      bind size, read size
      bind below, read top
`

const POP = `task pop-disk
  take piles, like list, like stack
  take pile, like number
  like number
  host top, read piles/{pile}
  fork case, read top
    case empty
      halt <empty>
    case disk
      save piles/{pile}, read below
      send back, read size
`

const MOVE = `task move-top
  take piles, like list, like stack
  take from, like number
  take to, like number
  call push-disk
    read piles
    call pop-disk
      read piles
      read from
    read to
`

// 1. Towers' move: pop taken out into a `let`, both bodies in the move, neither called
const towers = inlineStatements(checked(`${STACK}\n${PUSH}\n${POP}\n${MOVE}`))
ok('towers: move-top calls neither', callees(towers.program, 'move-top').length === 0, callees(towers.program, 'move-top').join(', '))
ok('towers: both answered as inlined', towers.inlined.has('push-disk') && towers.inlined.has('pop-disk'), [...towers.inlined].join(', '))

const lets = nodes(towers.program, 'move-top', 'let').map(n => n.name as string)
ok('towers: the popped size is a `let` named for its task', lets.includes('pop-disk-1'), lets.join(', '))
ok('towers: each callee local renamed apart', lets.includes('top-1') && lets.includes('top-2'), lets.join(', '))
ok('towers: the raise kept', nodes(towers.program, 'move-top', 'throw').length === 1)
ok('towers: the definitions are left for simplify', fn(towers.program, 'push-disk') !== undefined && fn(towers.program, 'pop-disk') !== undefined)

// 1b. the move inlined into its own caller in a later round: the move's body already holds both callees' locals, so
// every name must come out apart, each with one tag
const twice = inlineStatements(
  checked(`${STACK}\n${PUSH}\n${POP}\n${MOVE}\ntask move-twice
  take piles, like list, like stack
  call move-top
    read piles
    code 0
    code 1
  call move-top
    read piles
    code 1
    code 2
`),
)
const twiceLets = nodes(twice.program, 'move-twice', 'let').map(n => n.name as string)
ok('twice: move-twice calls nothing', callees(twice.program, 'move-twice').length === 0, callees(twice.program, 'move-twice').join(', '))
ok('twice: every local apart', new Set(twiceLets).size === twiceLets.length && twiceLets.length >= 6, twiceLets.join(', '))
ok('twice: one number a name', twiceLets.every(n => /^[a-z]+(-[a-z]+)*-\d+$/.test(n)), twiceLets.join(', '))

// 1c. a name an inlining makes is one nothing in the program spells the same way, on any backend: a caller that already
// has `top-1`, and `top1`, which Swift's camel case writes alike
const clash = inlineStatements(
  checked(`${STACK}\n${PUSH}\ntask crowded
  take piles, like list, like stack
  take top-1, like number
  take top1, like number
  call push-disk
    read piles
    read top-1
    read top1
`),
)
const clashLets = nodes(clash.program, 'crowded', 'let').map(n => n.name as string)
ok('clash: inlined', callees(clash.program, 'crowded').length === 0)
ok('clash: no name the caller spells alike', !clashLets.some(n => ['top1'].includes(n.replace(/[-_]/g, ''))), clashLets.join(', '))

// 2. a call whose answer is dropped: the arm's `send back, read size` leaves no statement of a bare variable
const dropped = inlineStatements(
  checked(`${STACK}\n${POP}\ntask drop-top
  take piles, like list, like stack
  call pop-disk
    read piles
    code 0
`),
)
ok('dropped answer: inlined', callees(dropped.program, 'drop-top').length === 0)
ok(
  'dropped answer: no bare variable left as a statement',
  !nodes(dropped.program, 'drop-top', 'expression').some(n => (n.expr as { form?: string }).form === 'variable'),
)

// 2b. a dropped answer that is a construction: its parts that do something, in order, never the construction itself,
// which on TypeScript was a bare object literal JavaScript reads as a block (the regex engine's `prepare-anew`)
const built = inlineStatements(
  checked(`${STACK}\ntask weigh
  take n, like number
  like number
  send back
    call add
      read n
      code 1

task wrap
  take piles, like list, like stack
  take n, like number
  like stack
  host top, read piles/0
  send back
    make disk
      bind size
        call weigh
          read n
      bind below, read top

task use
  take piles, like list, like stack
  call wrap
    read piles
    code 3
`),
)
const usedStatements = nodes(built.program, 'use', 'expression').map(n => (n.expr as { form?: string }).form)
ok('dropped construction: inlined', callees(built.program, 'use').every(c => c !== 'wrap'), callees(built.program, 'use').join(', '))
ok('dropped construction: no record left as a statement', !usedStatements.includes('record'), usedStatements.join(', '))
ok('dropped construction: the field that calls a task kept', callees(built.program, 'use').includes('weigh'), callees(built.program, 'use').join(', '))

// 3. what must NOT be inlined, each the shape that is but for one thing
const refuses = (label: string, text: string, callee: string, owner: string): void => {
  const out = inlineStatements(checked(text))
  ok(`refuses ${label}`, callees(out.program, owner).includes(callee) && !out.inlined.has(callee), callees(out.program, owner).join(', '))
}

refuses(
  'a task that calls itself',
  `${STACK}\ntask depth
  take s, like stack
  like number
  fork case, read s
    case empty
      send back, code 0
    case disk
      send back
        call add
          call depth(read(below))
          code 1

task outer
  take s, like stack
  like number
  host d, call depth(read(s))
  send back, read d
`,
  'depth',
  'outer',
)

refuses(
  'a return before the end',
  `${STACK}\ntask early
  take s, like stack
  like number
  fork test
    hook test
      call is-equal
        code 1
        code 1
    hook hold
      send back, code 1
  fork case, read s
    case empty
      send back, code 0
    case disk
      send back, read size

task outer
  take s, like stack
  like number
  host d, call early(read(s))
  send back, read d
`,
  'early',
  'outer',
)

refuses(
  'a loop',
  `${STACK}\ntask spin
  take piles, like list, like stack
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        code 3
    hook hold
      save piles/0, make empty
      save i
        call add
          read i
          code 1

task outer
  take piles, like list, like stack
  call spin(read(piles))
`,
  'spin',
  'outer',
)

refuses(
  'a field written of a record it was handed',
  `${STACK}\nform tally
  link count, like number
  link top, like stack

task bump
  take t, like tally
  like number
  save t/count
    call add
      read t/count
      code 1
  save t/top
    make disk
      bind size, read t/count
      bind below, read t/top
  send back, read t/count

task outer
  take t, like tally
  like number
  host n, call bump(read(t))
  send back, read n
`,
  'bump',
  'outer',
)

refuses(
  'a task that touches no recursive form',
  `task pick
  take a, like number
  take b, like number
  like number
  fork test
    hook test
      call is-below
        read a
        read b
    hook hold
      send back, read a
    hook miss
      send back, read b

task outer
  take a, like number
  like number
  host p
    call pick
      read a
      code 3
  send back, read p
`,
  'pick',
  'outer',
)

refuses(
  'a recursive form with no field-less case',
  `form ring
  case node
    link size, like number
    link next, like ring

task size-of
  take r, like ring
  like number
  fork case, read r
    case node
      send back, read size

task outer
  take r, like ring
  like number
  host n, call size-of(read(r))
  send back, read n
`,
  'size-of',
  'outer',
)

refuses(
  'an arm reading a field by the name of a parameter',
  `${STACK}\ntask clash
  take s, like stack
  take size, like number
  like number
  fork case, read s
    case empty
      send back, read size
    case disk
      send back, read size

task outer
  take s, like stack
  like number
  host n
    call clash
      read s
      code 4
  send back, read n
`,
  'clash',
  'outer',
)

refuses(
  'an async task',
  `${STACK}\ntask later
  take s, like stack
  mark async
  like number
  fork case, read s
    case empty
      send back, code 0
    case disk
      send back, read size

task outer
  take s, like stack
  like number
  host n, call later(read(s))
  send back, read n
`,
  'later',
  'outer',
)

refuses(
  'a task the view lowering calls by name',
  `${STACK}\ntask append
  take piles, like list, like stack
  take size, like number
  save piles/0
    make disk
      bind size, read size
      bind below, read piles/0

task outer
  take piles, like list, like stack
  call append
    read piles
    code 1
`,
  'append',
  'outer',
)

// 4. the definitions after `simplify`: dropped when no root, kept when a root, all kept when no roots are named
const towersText = `${STACK}\n${PUSH}\n${POP}\n${MOVE}`
const dropAll = simplify(checked(towersText), new Set(['move-top']))
ok('simplify: inlined tasks that are no root are dropped', !fn(dropAll, 'push-disk') && !fn(dropAll, 'pop-disk'))
ok('simplify: the root kept', fn(dropAll, 'move-top') !== undefined)

const keepRoot = simplify(checked(towersText), new Set(['move-top', 'pop-disk']))
ok('simplify: an inlined root keeps its definition', fn(keepRoot, 'pop-disk') !== undefined && !fn(keepRoot, 'push-disk'))

const noRoots = simplify(checked(towersText))
ok('simplify: no roots named keeps every definition', fn(noRoots, 'push-disk') !== undefined && fn(noRoots, 'pop-disk') !== undefined)

console.log(`\ninline-statements: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
