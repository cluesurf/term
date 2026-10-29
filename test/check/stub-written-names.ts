// A STUB'S CARRIED SHAPE AND BODY NAME EACH TASK AS ITS MODULE WROTE IT (items term-self-host-001-0323, 0324, 0325;
// compile/stub.ts `carried`). A task two files define is split by file, and the split name a unit gives is that unit's:
// mid.tree's `lift` sends back pub.tree's `bump`, `bump__in0_1` in mid's unit, and in a unit that also holds priv.tree's
// PRIVATE `bump` (x + 2) that name is priv's. Carried as mid's unit left it, the separate build proved the false rule
// `lift(x) == x + 2` and refused the true `lift(x) == x + 1`, and the kernel ran priv's identity `flip` for pub's
// negation. Each case is built merged and separate in three load orders, and both must give the expected answer. Last,
// one process builds the separate build that used to prove the false hold, then the merged one, which must still refuse.
// Run: npx tsx test/check/stub-written-names.ts
import { compile } from '@term/make/code/compile/compile'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Resolver } from '@term/make/code/compile/load'

type Built = {
  ok: boolean
  diagnostics?: { name: string; message: string; severity?: string }[]
}

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

const said = (r: Built): string =>
  r.ok
    ? 'ok'
    : (r.diagnostics ?? [])
        .filter(d => d.severity !== 'warning')
        .map(d => `${d.name}: ${d.message.slice(0, 120)}`)
        .join(' | ')
const slug = (file: string): string =>
  `./${file.replace(/\.tree$/, '').replace(/\W/g, '_')}.mjs`
const resolverOf =
  (files: Record<string, string>): Resolver =>
  path => {
    const name = path.replace(/^\.\//, '')
    const text = files[name]

    return text === undefined
      ? undefined
      : { file: `${name}.tree`, text }
  }

// pub's bump adds 1, priv's private bump adds 2, early's adds 3, and mid's lift is pub's
const INT = {
  pub: 'task bump\n  take a, like integer\n  like integer\n  send back, add(a, 1)\n',
  priv: 'task bump\n  mark private\n  take a, like integer\n  like integer\n  send back, add(a, 2)\n\ntask other\n  take a, like integer\n  like integer\n  send back, bump(a)\n',
  early:
    'task bump\n  take a, like integer\n  like integer\n  send back, add(a, 3)\n',
  mid: 'load ./priv\n  find other\n\nload ./pub\n  find bump\n\ntask lift\n  take a, like integer\n  like integer\n  send back, bump(a)\n',
}

// the same with pub's bump overloaded by arity, so the carried call is split AND mangled (`bump__in0_1__1`): the
// importer's arity pass gives the written call its arity again (check/disambiguate.tree `arity-statement`)
const OVER = {
  ...INT,
  pub: `${INT.pub}\ntask bump\n  take a, like integer\n  take b, like integer\n  like integer\n  send back, add(a, b)\n`,
}

const flipOf = (yes: string, no: string, priv = false): string =>
  `load ./flags\n  find flag\n\ntask flip\n${priv ? '  mark private\n' : ''}  take g, like flag\n  like flag\n  save h, read g\n  sift h\n    case yes\n      send back, make ${yes}\n    case no\n      send back, make ${no}\n`

// pub's flip negates, priv's private flip is the identity, early's is constant, and mid's toggle is pub's
const FLAG = {
  flags: 'form flag\n  case yes\n  case no\n',
  pub: flipOf('no', 'yes'),
  priv: `${flipOf('yes', 'no', true)}\ntask other\n  take g, like flag\n  like flag\n  send back, flip(g)\n`,
  early: flipOf('yes', 'yes'),
  mid: 'load ./flags\n  find flag\n\nload ./priv\n  find other\n\nload ./pub\n  find flip\n\ntask toggle\n  take g, like flag\n  like flag\n  send back, flip(g)\n',
}

const EQUAL =
  'form equal\n  head a\n  head x, like a\n  head y, like a\n  case refl\n    link c, like a\n    head\n      read c\n    head\n      read c\n'

const ORDERS = [
  ['early', 'priv', 'mid'],
  ['mid', 'priv', 'early'],
  ['priv', 'early', 'mid'],
]

const loadsOf = (
  order: string[],
  finds: Record<string, string>,
): string =>
  order
    .map(name => `load ./${name}\n  find ${finds[name]}\n`)
    .join('\n')

const holdIn = (k: number): string =>
  `task run\n  take x, like integer\n  like integer\n  hold is-equal(lift(x), add(x, ${k}))\n  send back, x\n`
const ruleOf = (k: number): string =>
  `rule lift-adds\n  seat x, like integer\n  show hold\n    call is-equal\n      call lift\n        read x\n      call add\n        read x\n        code ${k}\n`
const lawOf = (twice: boolean): string =>
  `rule toggle-law\n  take g, like flag\n  like equal flag\n    head\n      ${twice ? 'toggle(toggle(g))' : 'toggle(g)'}\n    head\n      read g\n\ntask toggle-law\n  take g\n  sift g\n    case yes\n      send back\n        make refl\n          bind c, make yes\n    case no\n      send back\n        make refl\n          bind c, make no\n`

function both(
  label: string,
  files: Record<string, string>,
  entry: string,
  want: boolean,
): void {
  const resolve = resolverOf(files)
  const merged = compile(
    { file: 'entry.tree', text: entry },
    { resolve, cache: new CompileCache() },
  ) as Built
  const separate = compileSeparate(
    { file: 'entry.tree', text: entry },
    { resolve, cache: new CompileCache(), modules: slug },
  ) as Built

  ok(
    `${label}: merged ${want ? 'proves' : 'refuses'}`,
    merged.ok === want,
    said(merged),
  )
  ok(
    `${label}: separate ${want ? 'proves' : 'refuses'}`,
    separate.ok === want,
    said(separate),
  )
}

for (const order of ORDERS) {
  const how = order.join(', ')
  const head = loadsOf(order, {
    early: 'bump',
    priv: 'other',
    mid: 'lift',
  })

  both(
    `rule lift(x) == x + 1, ${how}`,
    INT,
    `${head}\n${ruleOf(1)}`,
    true,
  )
  both(
    `rule lift(x) == x + 2 (priv's bump), ${how}`,
    INT,
    `${head}\n${ruleOf(2)}`,
    false,
  )
  both(
    `hold lift(x) == x + 1, ${how}`,
    INT,
    `${head}\n${holdIn(1)}`,
    true,
  )
  both(
    `rule lift(x) == x + 1, pub's bump overloaded, ${how}`,
    OVER,
    `${head}\n${ruleOf(1)}`,
    true,
  )
  both(
    `rule lift(x) == x + 2, pub's bump overloaded, ${how}`,
    OVER,
    `${head}\n${ruleOf(2)}`,
    false,
  )

  const flagHead = `load ./flags\n  find flag\n\n${loadsOf(order, { early: 'flip', priv: 'other', mid: 'toggle' })}`

  both(
    `claim toggle(toggle(g)) == g, ${how}`,
    FLAG,
    `${flagHead}\n${EQUAL}\n${lawOf(true)}`,
    true,
  )
  both(
    `claim toggle(g) == g (priv's identity), ${how}`,
    FLAG,
    `${flagHead}\n${EQUAL}\n${lawOf(false)}`,
    false,
  )
}

// ONE PROCESS, THE SEPARATE BUILD FIRST (item 0325): the hold lift(x) == x + 2 is false, and the separate build of the
// same closure in another load order once proved it and left that answer for the merged build after it
{
  const resolve = resolverOf(INT)
  const first = `${loadsOf(['early', 'priv', 'mid'], { early: 'bump', priv: 'other', mid: 'lift' })}\n${holdIn(2)}`
  const then = `${loadsOf(['mid', 'priv', 'early'], { early: 'bump', priv: 'other', mid: 'lift' })}\n${holdIn(2)}`
  const separate = compileSeparate(
    { file: 'entry.tree', text: first },
    { resolve, cache: new CompileCache(), modules: slug },
  ) as Built
  const merged = compile(
    { file: 'entry.tree', text: then },
    { resolve, cache: new CompileCache() },
  ) as Built

  ok(
    'the false hold, separate first: refused',
    !separate.ok,
    said(separate),
  )
  ok(
    'and the merged build after it in the same process: refused',
    !merged.ok,
    said(merged),
  )
}

console.log(`\nstub-written-names: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
