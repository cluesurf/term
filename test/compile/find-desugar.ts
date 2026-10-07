// A find lowers in a Term pass over the minted form (note/project/term/find, item 0007, decision 005).
//
// `compile/find-lower.tree` `lower-finds` rewrites each minted `find-query` into the core forms the bridge lowers: a
// `call` of `find-one`, `find-all` or `find-some` over `bind query, make find-query ...` and `bind body, task ...`
// (spec section 6.2). Held here:
//
//   1  the lowered tree is, field for field, what the code grammar mints for the program written out by hand, spans
//      and nodes aside (`runCodeMint` against `runMint` on the hand-written source), for a find of each count and
//      each query part
//   2  the shorthand and the explicit spelling lower to ONE tree (spec section 4.1)
//   3  a find in a real file compiles, and the emitted TypeScript is the TypeScript of the hand-written program,
//      for the shorthand and for the explicit spelling
//   4  a bare head in the body is `read it / link run, <npm dev>`, `call x` is a call, and a keyword form is kept
//   5  a value with no find in it comes back as the SAME object, list and form, so a program without a find mints as
//      it always did
//   6  what the pass cannot lower is a problem with the span of the find, never a silent drop
//
//   sh tmp/dec-tsx.sh test/compile/find-desugar.ts      (PRINT=1 prints each lowered tree)

import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { compile } from '@term/make/code/compile/compile'
import { loadRoleGrammar } from '@term/make/code/compile/mill-load'
import { runCodeMint, runMine, runMint } from '@term/make/code/compile/mill-run'
import type { MillMatch, Minted } from '@term/make/code/compile/mill-run'
import * as lowering from '@term/make/code/compile/find-lower'
import { projectResolver } from '@term/call/code/make'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const ROOT = join(HERE, '../..')
const MILL = join(ROOT, 'deck/mill/code/tree')

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 1800)}`)
  }
}

const grammar = loadRoleGrammar(MILL, 'code')

ok('the code grammar loads clean', grammar.problems.length === 0 && grammar.collisions.length === 0, JSON.stringify(grammar.problems))

// ---- reading a statement both ways ----

type Problem = { code: string; message: string; span?: unknown }

// a source minted through `flow`, as a task body's statements, lowered (`runCodeMint`) or not (`runMint`)
function minted(source: string, lowered: boolean): { values: Minted[]; problems: Problem[] } | undefined {
  const parsed = parse({ file: 'find.tree', text: source })

  if (!parsed.ok) return undefined

  const values: Minted[] = []
  const problems: Problem[] = []

  for (const group of parsed.tree.nodes) {
    const mined = runMine(grammar.mine, 'flow', { kind: 'root', nodes: [group] })

    if (!mined.ok) return undefined

    for (const captures of mined.match.values()) {
      for (const capture of captures) {
        if (capture.kind !== 'match') continue

        if (lowered) {
          const result = runCodeMint(grammar.mint, capture.rule, capture.match as MillMatch, capture.node)
          values.push(...result.values)
          problems.push(...result.problems)
        } else {
          values.push(...runMint(grammar.mint, capture.rule, capture.match as MillMatch, capture.node))
        }
      }
    }
  }

  return { values, problems }
}

// a minted value as a string with no span, no node and no empty field, fields in name order
function canon(value: Minted): string {
  if (value.kind === 'word') return `w:${value.value}`
  if (value.kind === 'text') return `t:${JSON.stringify(value.value)}`
  if (value.kind === 'number') return `n:${value.value}${value.decimal ? '.' : ''}`

  const parts: string[] = []

  for (const key of Object.keys(value.fields).sort()) {
    const list = value.fields[key]!

    if (list.length > 0) parts.push(`${key}=[${list.map(canon).join(' ')}]`)
  }

  return `${value.form}(${parts.join(' ')})`
}

// a tree, indented, for a failure to be read
function pretty(value: Minted, depth = 0): string {
  const pad = '  '.repeat(depth)

  if (value.kind !== 'form') return `${pad}${canon(value)}`

  const lines = [`${pad}${value.form}`]

  for (const key of Object.keys(value.fields).sort()) {
    const list = value.fields[key]!

    if (list.length === 0) continue

    lines.push(`${pad}  .${key}`)

    for (const item of list) lines.push(pretty(item, depth + 2))
  }

  return lines.join('\n')
}

// the first line on which two trees differ, to point at it
function firstDifference(a: Minted[], b: Minted[]): string {
  const left = a.map(value => pretty(value)).join('\n').split('\n')
  const right = b.map(value => pretty(value)).join('\n').split('\n')

  for (let at = 0; at < Math.max(left.length, right.length); at++) {
    if (left[at] !== right[at]) {
      return `line ${at}: lowered ${JSON.stringify(left[at])} hand ${JSON.stringify(right[at])}\n--- lowered\n${left.slice(Math.max(0, at - 6), at + 6).join('\n')}\n--- hand\n${right.slice(Math.max(0, at - 6), at + 6).join('\n')}`
    }
  }

  return ''
}

// ---- the hand-written targets ----
//
// Written out the way spec section 6.2 shows them, with every field of `find-query` (the empty parts as `make list`,
// `code 0` for no limit, `from-seconds` of 0 for no wait), each at indent 0 and shifted into place.

function shift(text: string, by: number): string {
  return text
    .split('\n')
    .map(line => (line === '' ? line : ' '.repeat(by) + line))
    .join('\n')
}

function haveTest(mode: string, name: string, value: string): string {
  return `make ${mode}\n  bind name, text <${name}>\n  bind value\n    make text\n      bind value, <${value}>\n`
}

function step(kind: string, like: string, tests: string[]): string {
  return `make find-step\n  bind kind, text <${kind}>\n  bind like, text <${like}>\n  bind turn, text <>\n  bind depth, text <>\n  bind test\n    make list\n${tests.map(test => shift(test, 6)).join('')}`
}

type Parts = {
  path?: string[]
  back?: string[]
  sort?: string[]
  size?: string
  head?: string
  sift?: string[]
  wait?: string
}

function query(count: string, base: string, line: string, parts: Parts = {}): string {
  const list = (items: string[] = []): string => items.map(item => shift(item, 8)).join('')

  return `bind query
  make find-query
    bind count
      make ${count}
    bind base
${shift(base, 6)}    bind path
      make list
${list(parts.path)}    bind union
      make list
    bind back
      make list
${list(parts.back)}    bind sort
      make list
${list(parts.sort)}    bind size, ${parts.size ?? 'code 0'}
    bind head, ${parts.head ?? 'code 0'}
    bind sift
      make list
${list(parts.sift)}    bind wait
${shift(parts.wait ?? 'call from-seconds\n  code 0\n', 6)}    bind line, text <${line}>
`
}

function body(param: string, kind: string, statements: string): string {
  return `bind body\n  task\n    take ${param}, like ${kind}\n${shift(statements, 4)}`
}

function call(name: string, queryText: string, bodyText = ''): string {
  return `call ${name}\n${shift(queryText, 2)}${shift(bodyText, 2)}`
}

const RUN = 'read it\n  link run, <npm dev>\n'
const SERVER_PANE = step('pane', '', [haveTest('have', 'title', 'server')])

type Fixture = { name: string; find: string; hand: string }

const FIXTURES: Fixture[] = [
  {
    name: 'the example of spec 6.2: find pane / have title, run',
    find: 'find pane\n  have title, <server>\n  run <npm dev>',
    hand: call('find-one', query('one', SERVER_PANE, 'find one pane'), body('it', 'pane', RUN)),
  },
  {
    name: 'its explicit spelling: find one / base pane',
    find: 'find one\n  base pane\n    have title, <server>\n\n  run <npm dev>',
    hand: call('find-one', query('one', SERVER_PANE, 'find one pane'), body('it', 'pane', RUN)),
  },
  {
    name: 'find all: a base with no test, the body once per hit',
    find: 'find all\n  base pane\n\n  clear',
    hand: call('find-all', query('all', step('pane', '', []), 'find all pane'), body('it', 'pane', 'read it\n  link clear\n')),
  },
  {
    name: 'find some: no body, a yes or no',
    find: 'find some\n  base pane\n    have title, <server>',
    hand: call('find-some', query('some', SERVER_PANE, 'find some pane')),
  },
  {
    name: 'a lack, and the result named by `, name`',
    find: 'find pane, name server\n  lack title, <shell>\n  focus',
    hand: call(
      'find-one',
      query('one', step('pane', '', [haveTest('lack', 'title', 'shell')]), 'find one pane'),
      body('server', 'pane', 'read server\n  link focus\n'),
    ),
  },
  {
    name: 'a path: the type of the body is the LAST kind',
    find: 'find one\n  base window\n    have title, <Term>\n\n  link tab\n\n  link pane\n    have title, <server>\n\n  run <npm dev>',
    hand: call(
      'find-one',
      query('one', step('window', '', [haveTest('have', 'title', 'Term')]), 'find one window tab pane', {
        path: [step('tab', '', []), step('pane', '', [haveTest('have', 'title', 'server')])],
      }),
      body('it', 'pane', RUN),
    ),
  },
  {
    name: 'a link with its relation',
    find: 'find one\n  base person\n\n  link person, like follows\n\n  click',
    hand: call(
      'find-one',
      query('one', step('person', '', []), 'find one person person', { path: [step('person', 'follows', [])] }),
      body('it', 'person', 'read it\n  link click\n'),
    ),
  },
  {
    name: 'a size, a head, a sift, a wait of seconds',
    find: 'find all\n  base file\n\n  sift path\n  size 50\n  head 3\n  wait <10s>',
    hand: call(
      'find-all',
      query('all', step('file', '', []), 'find all file', {
        sift: ['text <path>\n'],
        size: '50',
        head: '3',
        wait: 'call from-seconds\n  code 10\n',
      }),
      body('it', 'file', ''),
    ),
  },
]

function run(fixture: Fixture): void {
  const lowered = minted(fixture.find, true)
  const hand = minted(fixture.hand, false)

  ok(`${fixture.name}: the find reads`, lowered !== undefined && lowered.values.length === 1, JSON.stringify(lowered?.problems))
  ok(`${fixture.name}: the hand-written program reads`, hand !== undefined && hand.values.length === 1, fixture.hand)

  if (!lowered || !hand) return

  const same = lowered.values.map(canon).join('\n') === hand.values.map(canon).join('\n')

  ok(`${fixture.name}: the lowered tree is the hand-written tree`, same, same ? '' : firstDifference(lowered.values, hand.values))
  ok(`${fixture.name}: nothing was left unlowered`, lowered.problems.length === 0, JSON.stringify(lowered.problems))

  if (process.env.PRINT) {
    console.log(lowered.values.map(value => pretty(value)).join('\n'))
  }
}

for (const fixture of FIXTURES) run(fixture)

// ---- the shorthand and the explicit spelling are one tree ----

{
  const short = minted('find pane\n  have title, <server>\n  run <npm dev>', true)
  const explicit = minted('find one\n  base pane\n    have title, <server>\n\n  run <npm dev>', true)

  ok(
    'shorthand and explicit lower to one tree',
    short !== undefined && explicit !== undefined && short.values.map(canon).join() === explicit.values.map(canon).join(),
  )
}

// ---- the body ----

{
  const pipe = minted('find pane\n  run <npm dev>\n  click\n  call own\n  save line, <x>', true)
  const text = pipe?.values[0] ? canon(pipe.values[0]) : ''

  ok('a body with a bare head, a bare word, a call and a keyword lowers', pipe !== undefined && pipe.problems.length === 0)
  ok('a bare head with arguments is a pipe from the result', text.includes('seed-read(link=[call-link(name=[w:run] seed=[t:"npm dev"])] path=[w:it])'), text)
  ok('a bare word is a pipe from the result', text.includes('seed-read(link=[call-link(name=[w:click])] path=[w:it])'), text)
  ok('`call x` stays a call', text.includes('call(name=[w:own])'), text)
  ok('a keyword form keeps its meaning', text.includes('save(name=[w:line]'), text)
}

// ---- the query parts ----

{
  const parts = minted(
    'find all, name rows\n  base user\n    have status, <active>\n    hold is-minimum\n      bind a, read self/age\n      bind b, code 18\n\n  link friend, like follows\n\n  back name\n  back given, read self/first-name\n  sort fall, name size\n  sift name\n  size 50\n  head 3\n  wait <10s>',
    true,
  )
  const text = parts?.values[0] ? canon(parts.values[0]) : ''

  if (process.env.PRINT && parts) console.log(parts.values.map(value => pretty(value)).join('\n'))

  ok('every query part lowers', parts !== undefined && parts.problems.length === 0, JSON.stringify(parts?.problems))
  ok(
    'the base holds its haves, then its holds',
    text.indexOf('make(bind=[bind(name=[w:name] seed=[seed-text(value=[t:"status"])])') >= 0 &&
      text.indexOf('seed-text(value=[t:"status"])') < text.indexOf('seed-text(value=[t:"is-minimum"])'),
    text,
  )
  ok(
    'a hold names its predicate and reads its operands from the component or from a value',
    text.includes('bind(name=[w:a] seed=[make(bind=[bind(name=[w:name] seed=[seed-text(value=[t:"age"])])] name=[w:self])])') &&
      text.includes('bind(name=[w:b] seed=[make(bind=[bind(name=[w:value] seed=[make(bind=[bind(name=[w:value] seed=[seed-code(value=[n:18])])] name=[w:number])])] name=[w:value])])'),
    text,
  )
  ok('a link is a step with its relation', text.includes('bind(name=[w:like] seed=[seed-text(value=[t:"follows"])])'), text)
  ok(
    'a back reads the property of that name, or the one after it',
    text.includes('make(bind=[bind(name=[w:name] seed=[seed-text(value=[t:"name"])]) bind(name=[w:from] seed=[make(bind=[bind(name=[w:name] seed=[seed-text(value=[t:"name"])])] name=[w:self])])] name=[w:find-back])') &&
      text.includes('bind(name=[w:name] seed=[seed-text(value=[t:"first-name"])])'),
    text,
  )
  ok('a sort says fall as a flag', text.includes('bind(name=[w:fall] seed=[w:true])'), text)
  ok('size and head are the expressions written', text.includes('bind(name=[w:size] seed=[n:50])') && text.includes('bind(name=[w:head] seed=[n:3])'), text)
  ok('a wait of 10s is from-seconds of 10', text.includes('call(name=[w:from-seconds] seed=[seed-code(value=[n:10])])'), text)
  ok('with back lines the body takes the record, named by `, name`', text.includes('take(like=[like(name=[w:unknown])] name=[w:rows])'), text)
}

{
  const meet = minted('find all\n  base user\n    meet lack\n      have status, <banned>\n\n  back id', true)
  const text = meet?.values[0] ? canon(meet.values[0]) : ''

  ok('a meet lowers to a test with its members', meet !== undefined && meet.problems.length === 0, JSON.stringify(meet?.problems))
  ok(
    'the meet carries its kind and its tests',
    text.includes('make(bind=[bind(name=[w:kind] seed=[seed-text(value=[t:"lack"])]) bind(name=[w:test] seed=[make(name=[w:list] seed=[make(bind=[bind(name=[w:name] seed=[seed-text(value=[t:"status"])])'),
    text,
  )
}

{
  const waits = minted('find pane\n  wait <500ms>', true)
  const text = waits?.values[0] ? canon(waits.values[0]) : ''

  ok('a wait in milliseconds is from-milliseconds', text.includes('call(name=[w:from-milliseconds] seed=[seed-code(value=[n:500])])'), text)

  const minutes = minted('find pane\n  wait <2m>', true)

  ok('a wait in minutes is from-minutes', minutes !== undefined && canon(minutes.values[0]!).includes('w:from-minutes'))
}

// ---- a find as a value and nested ----

{
  const value = minted('save known\n  find some\n    base person\n      have name, <Alice>', true)
  const text = value?.values[0] ? canon(value.values[0]) : ''

  ok('a find in value position lowers to the call', value !== undefined && text.includes('call(') && text.includes('name=[w:find-some]'), text)
  ok('and no find-query form is left', !text.includes('find-query('), text)

  const nested = minted('find window\n  have title, <Term>\n  find button\n    have text, <Save>\n    click', true)
  const nestedText = nested?.values[0] ? canon(nested.values[0]) : ''

  ok('a nested find lowers inside the outer body', nested !== undefined && nested.problems.length === 0, JSON.stringify(nested?.problems))
  ok('both finds are calls and no find-query form is left', (nestedText.match(/name=\[w:find-one\]/g) ?? []).length === 2 && !nestedText.includes('find-query('), nestedText)
}

// ---- no change for a program with no find ----

{
  const sources = [
    'save x, <a>\ncall own\n  bind y, code 2',
    'fork test, is-equal(a, b)\n  hold\n    send back, true',
    'call find-one\n  bind query, read q',
  ]

  for (const source of sources) {
    const plain = minted(source, false)
    const lowered = minted(source, true)

    ok(
      `no find, no change: ${JSON.stringify(source.slice(0, 30))}`,
      plain !== undefined &&
        lowered !== undefined &&
        lowered.problems.length === 0 &&
        plain.values.length > 0 &&
        plain.values.map(canon).join() === lowered.values.map(canon).join(),
    )
  }

  // the same object back: the pass is handed a list and a form and returns them, not copies of them
  const word: Minted = { kind: 'word', value: 'x' }
  const inner: Minted = { kind: 'form', form: 'call', fields: new Map([['name', [word]]]) as never }
  const list = [inner, word]
  const out = lowering.lowerFinds(list as never)

  ok('no find: the list comes back as the same object', (out.values as unknown) === (list as unknown), 'a copy')
  ok('no find: no problems', out.problems.length === 0)
  ok('no find: the form inside is the same object', (out.values as unknown as Minted[])[0] === inner)
}

// ---- what is not lowered is said, with the span of the find ----

{
  const cases: { name: string; source: string; code: string }[] = [
    { name: 'find read <value>', source: 'find read tool\n  find pane\n    run <x>', code: 'find-read' },
    { name: 'take on a named find', source: 'find all, name rows\n  take role, like text\n\n  base user', code: 'find-take' },
    { name: 'a test under the find itself', source: 'find one\n  have title, <x>\n\n  base pane', code: 'find-test-place' },
    { name: 'no base', source: 'find all\n  link tab', code: 'find-no-base' },
    { name: 'two bases', source: 'find one\n  base pane\n\n  base window', code: 'find-two-bases' },
    { name: 'a body under find some', source: 'find some\n  base pane\n\n  click', code: 'find-body-on-some' },
    { name: 'a wait that is no whole unit', source: 'find pane\n  wait <soon>', code: 'find-wait-unit' },
  ]

  for (const one of cases) {
    const result = minted(one.source, true)
    const codes = result?.problems.map(p => p.code) ?? []

    ok(`${one.name}: a problem is raised`, codes.includes(one.code), `${JSON.stringify(result?.problems)} ${one.source}`)
    ok(`${one.name}: it carries the span of the find`, (result?.problems.length ?? 0) > 0 && (result?.problems.every(p => p.span !== undefined) ?? false))
  }
}

// ---- a file with a find compiles, to the TypeScript of the hand-written program ----

const resolve = projectResolver(ROOT, 'node')

// what a file that uses a find loads: the lowered code names the call, the IR forms and their cases, a duration and the
// kinds its body uses. The load is the file's own (`find` under a `load` is the import and untouched, spec section 3.1),
// and a name it lacks is an `unknown-name` at the find
const LOADS = `load @term/base/find
  find find-one

load @term/base/find/query
  find find-query
  find find-step
  find find-test
  find find-value
  find find-count

load @term/base/find/kind
  find pane
  find run

load @term/base/duration
  find from-seconds

`

function typescript(file: string, text: string): { ok: boolean; text: string } {
  const result = compile({ file: join(ROOT, 'tmp', file), text }, { resolve, env: 'node' })

  return result.ok
    ? { ok: true, text: result.typescript }
    : { ok: false, text: result.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ') }
}

{
  const inTask = (text: string): string => `${LOADS}task go\n${shift(text, 2)}`
  const hand = typescript('find-hand.tree', inTask(call('find-one', query('one', SERVER_PANE, 'find one pane'), body('it', 'pane', RUN))))
  const short = typescript('find-short.tree', inTask('find pane\n  have title, <server>\n  run <npm dev>\n'))
  const explicit = typescript('find-explicit.tree', inTask('find one\n  base pane\n    have title, <server>\n\n  run <npm dev>\n'))

  ok('the hand-written program compiles', hand.ok, hand.text)
  ok('the shorthand find compiles', short.ok, short.text)
  ok('the explicit find compiles', explicit.ok, explicit.text)
  ok('the shorthand emits the TypeScript of the hand-written program', hand.ok && short.ok && short.text === hand.text, 'differs')
  ok('the explicit spelling emits it too', hand.ok && explicit.ok && explicit.text === hand.text, 'differs')
  ok('the emitted program calls find-one with the query and a body', short.ok && /findOne\(/.test(short.text), short.ok ? short.text.slice(-600) : '')

  // a find with a refusal in it fails the build, naming the find
  const bad = typescript('find-bad.tree', inTask('find all\n  link tab\n'))

  ok('a find the pass cannot lower fails the build', !bad.ok && bad.text.includes('a path starts with base'), bad.text)

  // a file that does not load what the lowered code names says so, at the find
  const bare = typescript('find-bare.tree', 'task go\n  find pane\n    run <npm dev>\n')

  ok('a file without the loads fails the build, by name', !bare.ok && bare.text.includes('find-query'), bare.text)
}

console.log(`\nfind-desugar: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
