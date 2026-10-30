// The exception codec (decision 078 section 4 of note/project/term/self-host/change/001-finish-self-host, item
// term-self-host-001-0421): a raise crosses a parallel walk as one tree/code shape, written to the same bytes by
// TypeScript's `__termMeltRaise` and Rust's `term_melt_raise`, and filled back by `__termFillRaise` / `term_fill_raise`
// into the raise a `halt` of that form builds. Five raises, each caught in Term and melted: `over-limit` (text and
// number props), `wrapped` holding it as its cause, `wrapped` holding that one (a nested cause), a `failure` of a
// text (no props record), and `gathered`, whose props hold an exception and a list of them beside a number, each
// crossed by the codec again (decision 078 section 2, item 0439). For each, on each backend:
//   - the bytes filled and melted again are the bytes (the envelope, the props, every cause and the frames kept)
//   - the filled raise, re-raised and caught by a Term handler, sifts as its form with its props
//   - the bytes are the other backend's, `code` and `time` set aside (a fresh occurrence and clock per run)
//   - the other backend's bytes fill and melt back to themselves (the codec reads what the other one wrote)
// The codec is emitted for a program holding a parallel walk whose turn can raise (item 0436: a walk whose turns cannot
// raise keeps its output), so the program has one. RAISE_NATIVE=0 skips Rust.
// Run: npx tsx test/compile/raise-codec.ts (from deck/term/deck/term)

import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import {
  decodeTree,
  encodeTree,
} from '@term/make/code/compile/host-code'
import type { Data } from '@term/make/code/compile/host'
import { runOn, type Backend } from './shared/run-on'

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

// each raise, and what a handler that catches it again reads
const CASES = [
  { name: 'over-limit', sifted: 'over-limit:9:cap' },
  { name: 'a cause', sifted: 'wrapped:outer' },
  { name: 'a nested cause', sifted: 'wrapped:outer2' },
  { name: 'failure of a text', sifted: 'failure:too many 9' },
  { name: 'exception props', sifted: 'gathered:wrapped:1' },
]

const BIND_CASES = `  case browser
    text <0>
  case swift
    text <0>
  case kotlin
    text <0>`

// the program: the raises when `hexes` is absent, else the bytes given, each filled, melted and re-raised
const programOf = (
  hexes?: string[],
): string => `load @term/base/exception
  find exception

load @term/base/maybe
  find maybe

load @term/host/code/base
  find data
  find to-code
  find from-code

load @term/base/list
  find list
  find get

load @term/base/bytes
  find to-hex
  find from-hex

form over-limit
  like exception
    bind note, <Over the limit>
    link limit, like number
    link label, like text

form wrapped
  like exception
    bind note, <Wrapped>
    link step, like text

form gathered
  like exception
    bind note, <Gathered>
    link first, like exception
    link rest, like list, like exception
    link count, like number

bind melt-raise
  take raised, like exception
  like data
  case node
    text <__termMeltRaise($raised)>
  case rust
    text <term_melt_raise(&$raised)>
${BIND_CASES}

bind fill-melt
  take given, like data
  like data
  case node
    text <__termMeltRaise(__termFillRaise($given))>
  case rust
    text <term_melt_raise(&term_fill_raise($given).unwrap_or_else(|e| e))>
${BIND_CASES}

bind reraise
  take given, like data
  like number
  case node
    text <(() =\\> \\{ throw __termFillRaise($given) \\})()>
  case rust
    text <\\{ return std::result::Result::Err(match term_fill_raise($given) \\{ Ok(e) =\\> e, Err(e) =\\> e \\}); \\}>
${BIND_CASES}

task spin
  take xs, like list, like number
  like number
  walk xs, mark parallel
    take x
    save y, check(x)
  back 0

task check
  take n, like number
  like number
  fork test, is-above(n, 3)
    hold
      halt over-limit
        bind limit, n
        bind label, <cap>
  back n

task outer
  take n, like number
  like number
  fork
    mark unsafe
    save x, check(n)
    back x
  halt take
    take problem
    halt wrapped
      bind step, <outer>
      bind base, make(some, problem)
  back 0

task outer2
  take n, like number
  like number
  fork
    mark unsafe
    save x, outer(n)
    back x
  halt take
    take problem
    halt wrapped
      bind step, <outer2>
      bind base, make(some, problem)
  back 0

task text-fail
  take n, like number
  like number
  fork test, is-above(n, 3)
    hold
      halt <too many {n}>
  back n

task gather
  take n, like number
  like number
  fork
    mark unsafe
    save x, outer(n)
    back x
  halt take
    take problem
    halt gathered
      bind first, problem
      bind rest, make list(problem)
      bind count, 1
  back 0

task crossed
  take given, like data
  take n, like number
  like number
  fork test, is-below(n, 0)
    hold
      halt over-limit
        bind limit, 0
        bind label, <never>
  fork test, is-below(n, -1)
    hold
      halt wrapped
        bind step, <never>
  fork test, is-below(n, -2)
    hold
      save g, gather(9)
  save z, reraise(given)
  back z

task hex-of
  take one, like data
  like text
  back to-hex(to-code(one))

task data-of
  take hex, like text
  like data
  back get(from-code(from-hex(hex)), 0)

task again
  take hex, like text
  like text
  save round, hex-of(fill-melt(data-of(hex)))
  save given, data-of(hex)
  fork
    mark unsafe
    save z, crossed(given, 1)
  halt take
    take problem
    sift problem
      case over-limit
        back <{round}|{problem/form}:{limit}:{label}>
      case wrapped
        back <{round}|{problem/form}:{step}>
      case gathered
        back <{round}|{problem/form}:{first/form}:{rest/length}>
      miss
        back <{round}|{problem/form}:{problem/note}>
  back <{round}|none>

task run
  like text
  save out, make list
${
  hexes
    ? hexes.map(hex => `  push(out, <${hex}>)`).join('\n')
    : ['check', 'outer', 'outer2', 'text-fail', 'gather']
        .map(
          (task, at) => `  fork
    mark unsafe
    save raised${at}, ${task}(9)
  halt take
    take problem
    push(out, hex-of(melt-raise(problem)))`,
        )
        .join('\n')
}
  save lines, make list
  walk out
    take hex
    push(lines, <{hex}|{again(hex)}>)
  back join(lines, <\\n>)
`

const HERE =
  import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const root = mkdtempSync(join(tmpdir(), 'term-raise-codec-'))
mkdirSync(join(root, 'link/@term'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
symlinkSync(join(TERM, 'deck/host'), join(root, 'link/@term/host'))
writeFileSync(
  join(root, 'deck.tree'),
  'deck @probe/raise-codec\n  code <0.0.0>\n',
)
const out = join(root, 'out')
mkdirSync(out, { recursive: true })
// one path on every backend, which every frame names
const file = join(root, 'code', 'raise-codec.tree')
const backends: Backend[] =
  process.env.RAISE_NATIVE === '0'
    ? ['typescript']
    : ['typescript', 'rust']

type Line = { hex: string; round: string; sifted: string }

// the lines a program answered, or why it did not
function run(
  backend: Backend,
  program: string,
  name: string,
): Line[] | string {
  const ran = runOn({
    backend,
    program,
    resolve: env => projectResolver(root, env),
    dir: out,
    name,
    file,
  })

  if (ran.form === 'skipped') {
    return `skipped: ${ran.reason}`
  }

  if (ran.form === 'failed') {
    return `${ran.stage}: ${ran.reason.slice(0, 900)}`
  }

  return ran.output.split('\n').map(line => {
    const [hex = '', round = '', sifted = ''] = line.split('|')

    return { hex, round, sifted }
  })
}

const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex, 'hex'))
const hexOf = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('hex')

function decoded(hex: string): Data | undefined {
  const read = decodeTree(bytesOf(hex))

  return read.ok ? read.values[0] : undefined
}

const field = (
  value: Data | undefined,
  name: string,
): Data | undefined =>
  value?.kind === 'hash'
    ? value.list.find(entry => entry.name === name)?.base
    : undefined

// the raise with its `code` and `time` set aside, at every depth of its causes
function masked(value: Data): Data {
  if (value.kind !== 'hash') {
    return value
  }

  return {
    kind: 'hash',
    list: value.list.map(entry =>
      entry.name === 'code'
        ? { name: 'code', base: { kind: 'text', value: '' } }
        : entry.name === 'time'
          ? { name: 'time', base: { kind: 'number', value: 0 } }
          : entry.name === 'base'
            ? { name: 'base', base: masked(entry.base) }
            : entry.name === 'link'
              ? { name: 'link', base: maskedProps(entry.base) }
              : entry,
    ),
  }
}

// a raise inside the props, as a field or a list's item (item 0439), masked as a cause is
const isRaise = (value: Data): boolean =>
  value.kind === 'hash' && value.list.some(entry => entry.name === 'host')

function maskedProps(value: Data): Data {
  if (value.kind !== 'hash') {
    return value
  }

  return {
    kind: 'hash',
    list: value.list.map(entry => ({
      name: entry.name,
      base: isRaise(entry.base)
        ? masked(entry.base)
        : entry.base.kind === 'list'
          ? {
              kind: 'list',
              list: entry.base.list.map(item =>
                isRaise(item) ? masked(item) : item,
              ),
            }
          : entry.base,
    })),
  }
}

const answers = new Map<Backend, Line[]>()

for (const backend of backends) {
  const lines = run(backend, programOf(), `raise-${backend}`)

  if (typeof lines === 'string') {
    if (lines.startsWith('skipped')) {
      console.log(`skip  ${backend}: ${lines}`)
      continue
    }

    ok(`${backend}: the program builds and runs`, false, lines)
    continue
  }

  answers.set(backend, lines)
  CASES.forEach((one, at) => {
    const line = lines[at]
    ok(
      `${backend}: ${one.name} fills and melts back to its own bytes`,
      line !== undefined && line.hex !== '' && line.round === line.hex,
      line
        ? `melted ${line.hex.slice(0, 80)} filled-and-melted ${line.round.slice(0, 80)}`
        : 'no line',
    )
    ok(
      `${backend}: ${one.name} re-raised is caught as ${one.sifted}`,
      line?.sifted === one.sifted,
      `got ${JSON.stringify(line?.sifted)}`,
    )
  })

  // what the bytes hold: the props, the cause and its cause, and none for a text's failure
  const [limit, cause, nested, text, gathered] = lines.map(line =>
    decoded(line.hex),
  )
  const limitLink = field(limit, 'link')
  ok(
    `${backend}: over-limit's props are its own melt (limit 9, label cap)`,
    JSON.stringify(field(limitLink, 'limit')) ===
      '{"kind":"number","value":9}' &&
      JSON.stringify(field(limitLink, 'label')) ===
        '{"kind":"text","value":"cap"}',
    JSON.stringify(limitLink),
  )
  ok(
    `${backend}: a cause is the codec again, over-limit inside wrapped`,
    JSON.stringify(field(field(cause, 'base'), 'form')) ===
      '{"kind":"text","value":"over-limit"}',
  )
  ok(
    `${backend}: a nested cause holds wrapped holding over-limit`,
    JSON.stringify(field(field(nested, 'base'), 'form')) ===
      '{"kind":"text","value":"wrapped"}' &&
      JSON.stringify(
        field(field(field(nested, 'base'), 'base'), 'form'),
      ) === '{"kind":"text","value":"over-limit"}',
  )
  ok(
    `${backend}: a failure of a text carries no props record and no cause`,
    text !== undefined &&
      field(text, 'link') === undefined &&
      field(text, 'base') === undefined,
  )
  // item 0439: a props field typed as an exception, and a list of them, cross by the codec again
  const gatheredLink = field(gathered, 'link')
  const first = field(gatheredLink, 'first')
  const rest = field(gatheredLink, 'rest')
  ok(
    `${backend}: an exception props field is the codec again, wrapped holding over-limit`,
    JSON.stringify(field(first, 'form')) ===
      '{"kind":"text","value":"wrapped"}' &&
      JSON.stringify(field(field(first, 'base'), 'form')) ===
        '{"kind":"text","value":"over-limit"}',
    JSON.stringify(gatheredLink).slice(0, 600),
  )
  ok(
    `${backend}: a list of exceptions props field is the codec again for each, beside a number`,
    rest?.kind === 'list' &&
      rest.list.length === 1 &&
      rest.list.every(
        item =>
          JSON.stringify(field(item, 'form')) ===
          '{"kind":"text","value":"wrapped"}',
      ) &&
      JSON.stringify(field(gatheredLink, 'count')) ===
        '{"kind":"number","value":1}',
    JSON.stringify(rest).slice(0, 600),
  )
}

// the same raise, the same bytes on both backends, `code` and `time` set aside
const ts = answers.get('typescript')
const rust = answers.get('rust')

if (ts && rust) {
  CASES.forEach((one, at) => {
    const left = decoded(ts[at]?.hex ?? '')
    const right = decoded(rust[at]?.hex ?? '')
    const same =
      left !== undefined &&
      right !== undefined &&
      hexOf(encodeTree(masked(left))) ===
        hexOf(encodeTree(masked(right)))
    ok(
      `${one.name}: TypeScript and Rust write the same bytes, code and time aside`,
      same,
      `typescript ${JSON.stringify(left && masked(left)).slice(0, 400)} rust ${JSON.stringify(right && masked(right)).slice(0, 400)}`,
    )
  })

  // each backend fills what the other wrote, and melts it back to the same bytes
  for (const [backend, given] of [
    ['typescript', rust],
    ['rust', ts],
  ] as const) {
    const lines = run(
      backend,
      programOf(given.map(line => line.hex)),
      `cross-${backend}`,
    )

    if (typeof lines === 'string') {
      ok(
        `${backend}: the program filling the other backend's bytes builds and runs`,
        false,
        lines,
      )
      continue
    }

    CASES.forEach((one, at) => {
      const line = lines[at]
      ok(
        `${backend}: ${one.name} as the other backend wrote it fills and melts back to those bytes`,
        line !== undefined &&
          line.hex === given[at]?.hex &&
          line.round === line.hex,
        line
          ? `given ${line.hex.slice(0, 60)} round ${line.round.slice(0, 60)}`
          : 'no line',
      )
      ok(
        `${backend}: ${one.name} as the other backend wrote it is caught as ${one.sifted}`,
        line?.sifted === one.sifted,
        `got ${JSON.stringify(line?.sifted)}`,
      )
    })
  }
}

console.log(`\nraise-codec: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
