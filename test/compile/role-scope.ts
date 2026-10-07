// GRAMMAR SCOPES, end to end (note/term/mill/02-role-scopes.md, 03-note-grammar.md): a program written with
// `role note, ...`, with a name imported as a grammar, inline, in parentheses and as a block, compiled through the
// whole pipeline and RUN, each answer held to the value the notation means. Then what must be refused, with the
// message and the place. A scope that compiled to the wrong code would pass any test that only looked at the tree.
//
// Run: npx tsx test/compile/role-scope.ts

import { transformSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { readFeedMineGrammar, feedMineUnknownRefs } from '@term/make/code/compile/feed-mill'
import { parse } from '@term/make/code/parser/tree'
import { projectResolver } from '@term/call/code/make'
import { declaresDraft } from '@term/call/code/draft'

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

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const BASE = join(HERE, '../../deck/base')
const resolve = projectResolver(BASE)

// what one compile gives: the tasks to call, or the diagnostics
type Built = { tasks?: Record<string, (...args: unknown[]) => unknown>; problems: { name: string; message: string; line: number; column: number }[] }

function build(text: string, names: string[], lean = false): Built {
  const result = compile({ file: join(BASE, 'code', 'scope-probe.tree'), text }, { resolve, optimize: false, leanOf: () => lean } as never)

  if (!result.ok) {
    return {
      problems: result.diagnostics.map(d => ({
        name: d.name,
        message: d.message,
        line: d.span.start.line,
        column: d.span.start.column,
      })),
    }
  }

  const body = transformSync(result.typescript.replace(/^export /gm, ''), { loader: 'ts' }).code
  const tasks = new Function(`${body}\nreturn { ${names.join(', ')} }`)() as Built['tasks']

  return { tasks, problems: [] }
}

function value(text: string, name: string, args: unknown[] = [], lean = false): unknown {
  const built = build(text, [name], lean)

  if (!built.tasks) {
    return `NOT BUILT: ${built.problems.map(p => `${p.name} ${p.line}:${p.column} ${p.message}`).join(' | ')}`
  }

  return built.tasks[name]!(...args)
}

const LOAD = 'load @term/mill/text/note\n  find note\n\n'

// ---- the spellings ----

ok(
  '`role note, x + y * 2` inline, after a comma',
  value('task f\n  take x, like number\n  take y, like number\n  like number\n  send back, role note, x + y * 2\n', 'f', [1, 3]) === 7,
)

ok(
  '`role note` and the block indented under it',
  value('task f\n  take x, like number\n  like number\n  send back\n    role note\n      x^2\n        + 1\n', 'f', [3]) === 10,
)

ok(
  'a grammar imported by name needs no `role`: `note x - 1`',
  value(`${LOAD}task f\n  take x, like number\n  like number\n  send back, note x - 1\n`, 'f', [5]) === 4,
)

ok(
  'in parentheses: `note(x * (x + 1))`',
  value(`${LOAD}task f\n  take x, like number\n  like number\n  send back, note(x * (x + 1))\n`, 'f', [4]) === 20,
)

ok(
  'under an alias: `find note, name math`, then `math x + 1`',
  value('load @term/mill/text/note\n  find note, name math\n\ntask f\n  take x, like number\n  like number\n  send back, math x + 1\n', 'f', [1]) === 2,
)

ok(
  'a project\'s own mill: `load ./some/mill`',
  value('load ./some/mill\n  find note\n\ntask f\n  take x, like number\n  like number\n  send back, note x * 10\n', 'f', [2]) === 20,
)

ok(
  '`find role note`, under any load',
  value('load ./anything\n  find role note\n\ntask f\n  take x, like number\n  like number\n  send back, note x + x\n', 'f', [2]) === 4,
)

ok(
  'a literal written out is the same scope: `role note, <<x + 1>>`',
  value('task f\n  take x, like number\n  like number\n  send back, role note, <<x + 1>>\n', 'f', [2]) === 3,
)

ok(
  'in a lean file: `back role note, x * 3`',
  value('task f\n  take x, like number\n  like number\n  back role note, x * 3\n', 'f', [2], true) === 6,
)

ok(
  'a statement `note total = x * 3` assigns',
  value(`${LOAD}task f\n  take x, like number\n  like number\n  note total = x * 3\n  send back, read total\n`, 'f', [5]) === 15,
)

// ---- what it means ----

ok(
  'comparison and logic: `0 < x < 10 and x != 5`',
  JSON.stringify([1, 5, 12].map(x => value(`${LOAD}task f\n  take x, like number\n  like boolean\n  send back, note 0 < x < 10 and x != 5\n`, 'f', [x]))) ===
    '[true,false,false]',
)

ok(
  'a power of whole numbers: `2^10`',
  value(`${LOAD}task f\n  like number\n  send back, note 2^10\n`, 'f') === 1024,
)

ok(
  'a power of decimals: `2.0^0.5`',
  Math.abs((value(`${LOAD}task f\n  like float\n  send back, note 2.0^0.5\n`, 'f') as number) - Math.SQRT2) < 1e-12,
)

ok(
  'scientific notation is exact: `1.5e3 + 0.5`',
  value(`${LOAD}task f\n  like float\n  send back, note 1.5e3 + 0.5\n`, 'f') === 1500.5,
)

ok(
  'a list, and an index into it: `[10, 20, 30][1]`',
  value(`${LOAD}task f\n  like number\n  save xs, note [10, 20, 30]\n  send back, note xs[1]\n`, 'f') === 20,
)

ok(
  'a set holds each value once: `{1, 2, 2, 3}`',
  value(`${LOAD}load @term/base/set\n  find set\n\ntask f\n  like number\n  save s, note \{1, 2, 2, 3\}\n  send back, call s/length\n`, 'f') === 3,
)

const membership = JSON.stringify(
  ['2 in {1, 2, 3}', '5 ∈ {1, 2, 3}'].map(e => value(`${LOAD}load @term/base/set\n  find set\n\ntask f\n  like boolean\n  send back, note ${e}\n`, 'f')),
)

ok('membership: `2 in {1, 2, 3}` and `5 ∈ {1, 2, 3}`', membership === '[true,false]', membership)

const operated = JSON.stringify(
  ['{1, 2} ∪ {2, 3}', '{1, 2} ∩ {2, 3}', '{1, 2} \\ {2, 3}'].map(e =>
    value(`${LOAD}load @term/base/set\n  find set\n\ntask f\n  like number\n  save s, note ${e}\n  send back, call s/length\n`, 'f'),
  ),
)

ok('the set operators: `{1, 2} ∪ {2, 3}` holds three, `{1, 2} ∩ {2, 3}` one, `{1, 2} \\ {2, 3}` one', operated === '[3,1,1]', operated)

ok(
  'a negative: `-x * 2` and `-3 + x`',
  JSON.stringify([value(`${LOAD}task f\n  take x, like number\n  like number\n  send back, note -x * 2\n`, 'f', [4]), value(`${LOAD}task f\n  take x, like number\n  like number\n  send back, note -3 + x\n`, 'f', [4])]) === '[-8,1]',
)

ok(
  '`1..5` holds both ends, five numbers',
  value(`${LOAD}load @term/base/range\n  find range\n\ntask f\n  like number\n  save r, note 1..5\n  send back, call r/length\n`, 'f') === 5,
)

ok(
  '`0..<5` and `[0, 5)` leave the end out, `(0, 5]` the start',
  JSON.stringify(['0..<5', '[0, 5)', '(0, 5]'].map(r => value(`${LOAD}load @term/base/range\n  find range\n\ntask f\n  like number\n  save r, note ${r}\n  send back, add(call(r/length), read(r/start))\n`, 'f'))) ===
    '[5,5,6]',
)

ok(
  'a member: `p.x + p.y`',
  value(`${LOAD}form point\n  link x, like number\n  link y, like number\n\ntask f\n  like number\n  save p\n    make point\n      bind x, code 3\n      bind y, code 4\n  send back, note p.x + p.y\n`, 'f') === 7,
)

ok(
  'a call: `twice(x) + 1`',
  value(`${LOAD}task twice\n  take n, like number\n  like number\n  send back, note n * 2\n\ntask f\n  take x, like number\n  like number\n  send back, note twice(x) + 1\n`, 'f', [4]) === 9,
)

ok(
  'a text: `"hello"`',
  value(`${LOAD}task f\n  like text\n  send back, note "hello <there>"\n`, 'f') === 'hello <there>',
)

// ---- quantities ----

const UNIT = 'load @term/base/unit\n  find quantity\n\n'

function quantity(expression: string, read: string): unknown {
  return value(`${LOAD}${UNIT}task f\n  like ${read === 'unit' ? 'text' : 'float'}\n  save q, note ${expression}\n  send back, read q/${read}\n`, 'f')
}

ok('`9.81m/s^2` is 9.81 of m/s^2', quantity('9.81m/s^2', 'value') === 9.81 && quantity('9.81m/s^2', 'unit') === 'm/s^2')
ok('`20MB/s` is 160,000,000 bits a second in base units', quantity('20MB/s', 'scale') === 8000000 && quantity('20MB/s', 'unit') === 'MB/s')
ok('`20Mb/s` is eight times less: casing is meaning', quantity('20Mb/s', 'scale') === 1000000)
ok('`20 MB/s`: a space before a word unit is allowed', quantity('20 MB/s', 'unit') === 'MB/s')
ok('`100m / 10s` divides two quantities: 10 m/s', quantity('100m / 10s', 'value') === 10 && quantity('100m / 10s', 'unit') === 'm/s')
ok('`1km + 500m` is given in the left one\'s unit: 1.5 km', quantity('1km + 500m', 'value') === 1.5)
ok('`2 * 3m` scales: 6 m', quantity('2 * 3m', 'value') === 6)
ok('`$20 + $5` is 25 USD', quantity('$20 + $5', 'value') === 25 && quantity('$20 + $5', 'unit') === 'USD')
ok('`50%` is a hundredth of 50', quantity('50%', 'scale') === 0.01)

ok(
  '`5m < 2km` compares in base units',
  value(`${LOAD}task f\n  like boolean\n  send back, note 5m < 2km\n`, 'f') === true,
)

ok(
  '`1km + 1s` measures two different things and is refused when it runs',
  (() => {
    try {
      quantity('1km + 1s', 'value')
      return false
    } catch (error) {
      return error instanceof Error && /measure different things/.test(error.message)
    }
  })(),
)

// ---- what is refused, and where ----

function refused(text: string): Built['problems'][number] | undefined {
  return build(text, []).problems[0]
}

const unregistered = refused(`${LOAD}task f\n  like float\n  save q, note 20mb/s\n  send back, read q/value\n`)

ok(
  'an unregistered unit is refused, at the unit: `20mb/s`',
  unregistered?.name === 'scope-refused' && /`mb` is not a registered unit/.test(unregistered.message) && unregistered.line === 5 && unregistered.column === 17,
  JSON.stringify(unregistered),
)

const noGrammar = refused('task f\n  like number\n  send back, role sums, 1 + 2\n')

ok(
  'a role naming no grammar is refused: `role sums, 1 + 2`',
  noGrammar?.name === 'unknown-grammar' && /`sums`/.test(noGrammar.message),
  JSON.stringify(noGrammar),
)

const noMeaning = refused(`${LOAD}task f\n  like boolean\n  send back, note a -> b\n`)

ok(
  'an operator Term gives no meaning yet is refused: `a -> b`',
  noMeaning?.name === 'scope-refused' && /`->` is read by the note grammar/.test(noMeaning.message),
  JSON.stringify(noMeaning),
)

const mixed = refused(`${LOAD}task f\n  like float\n  save q, note 3m + 2\n  send back, read q/value\n`)

ok(
  'a quantity and a plain number are not added: `3m + 2`',
  mixed?.name === 'scope-refused' && /plain number/.test(mixed.message),
  JSON.stringify(mixed),
)

const broken = refused(`${LOAD}task f\n  like number\n  send back, note (1 + 2\n`)

ok(
  'a grammar mistake is reported where it was written: `(1 + 2`',
  broken?.name === 'scope-refused' && /ends where .*`\)`.* was wanted/.test(broken.message) && broken.line === 5,
  JSON.stringify(broken),
)

ok(
  'a file role is never a scope: `role mill` stays a role rule',
  build('role mill\n  take @/code/**/*.tree\n', []).problems.every(p => p.name !== 'unknown-grammar' && p.name !== 'scope-refused'),
)

// ---- the guide's samples, as written there (note/term/guides/language/dsls/roles.md) ----

const GUIDE_ROLE = `task speed
  take distance, like float
  take time, like float
  like float
  send back, role note, distance / time

task area
  take r, like float
  like float
  send back
    role note
      3.14159 * r^2
`

const GUIDE_LOAD = `load @term/mill/text/note
  find note

task within
  take x, like number
  like boolean
  send back, note 0 < x < 10 and x != 5

task rate
  like float
  save q, note 20MB/s
  send back, call q/in-base
`

const guideRole = build(GUIDE_ROLE, ['speed', 'area'])

ok(
  'the guide\'s `role note` sample builds and computes',
  guideRole.tasks !== undefined && guideRole.tasks.speed!(100, 8) === 12.5 && Math.abs((guideRole.tasks.area!(2) as number) - 12.56636) < 1e-9,
  JSON.stringify(guideRole.problems),
)

const guideLoad = build(GUIDE_LOAD, ['within', 'rate'])

ok(
  'the guide\'s imported `note` sample builds and computes',
  guideLoad.tasks !== undefined && guideLoad.tasks.within!(3) === true && guideLoad.tasks.within!(5) === false && guideLoad.tasks.rate!() === 160000000,
  JSON.stringify(guideLoad.problems),
)

ok(
  'a small whole power of a decimal name is its factors: `r^3` with `r` a float',
  value(`${LOAD}task f\n  take r, like float\n  like float\n  send back, note r^3\n`, 'f', [1.5]) === 3.375,
)

// ---- the grammar's spec ----

const SPEC = join(HERE, '../../deck/mill/code/text/note/mine.tree')
const specText = readFileSync(SPEC, 'utf8')
const spec = parse({ file: SPEC, text: specText })

ok('the note grammar\'s spec (mine.tree) parses', spec.ok)

if (spec.ok) {
  const grammar = readFeedMineGrammar(spec.tree as never)
  const declared = specText.split('\n').filter(line => line.startsWith('mine ')).map(line => line.slice(5).trim())

  ok(`it declares ${declared.length} rules, each read`, declared.every(name => (grammar.get(name) ?? []).length > 0), declared.filter(name => (grammar.get(name) ?? []).length === 0).join(', '))
  ok('it names no rule it does not define', feedMineUnknownRefs(grammar).length === 0, feedMineUnknownRefs(grammar).join(', '))

  ok('it is the parser: not shelved', !declaresDraft(specText))
}

// the grammar the build runs is mine.tree byte for byte: the baked copy is regenerated, never edited
const bundled = spawnSync('pnpm', ['exec', 'tsx', 'task/term/grammar-bundle.ts', '--check'], { cwd: join(HERE, '../../../../../..'), encoding: 'utf8' })

ok('the grammar the build runs is mine.tree as written (pnpm term:grammar-bundle --check)', bundled.status === 0, `${bundled.stdout}${bundled.stderr}`)

console.log(`\nrole-scope: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
