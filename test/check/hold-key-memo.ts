// A definition's hold key text, kept (decision 102 of term/self-host/change/001-finish-self-host, check/hold-key-text.tree).
// The memo's key must tell apart every two statements whose node-json differs, and may leave out only `span`: here
// pairs that differ in one place a plain JSON text would merge (a number JSON cannot write, -0, an absent value in a
// list, a Map's or a Set's entries, a bigint) each get two keys, a statement moved in its file keeps its key, a value
// it cannot write exactly gets none, and a program checked with the memo full answers exactly as one checked with it
// empty. Run: npx tsx test/check/hold-key-memo.ts

import { compile } from '@term/make/code/compile/compile'
import { clearHoldMemo, holdKeyMemoSize } from '@term/make/code/check/holds'
import { freshKeyMemo, memoKey } from '@term/make/code/check/hold-key-text'

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

const memo = freshKeyMemo()
const key = (statement: unknown): string => memoKey(memo, statement)
const at = (line: number) => ({ start: { line, column: 1, offset: 0 }, end: { line, column: 9, offset: 8 } })
const literal = (value: unknown, line = 1) => ({ form: 'return', value: { form: 'some', value: { form: 'number', value, span: at(line) } }, span: at(line) })

ok('a statement moved in its file keeps its key', key(literal(3, 1)) === key(literal(3, 40)))
ok('two numbers, two keys', key(literal(3)) !== key(literal(4)))
ok('NaN is not null', key(literal(Number.NaN)) !== key(literal(null)))
ok('Infinity is not null', key(literal(Number.POSITIVE_INFINITY)) !== key(literal(null)))
ok('-0 is not 0', key(literal(-0)) !== key(literal(0)))
ok('a bigint is not its text', key(literal(5n)) !== key(literal('5')))
ok('an absent value in a list is not null', key({ list: [undefined] }) !== key({ list: [null] }))
ok('a Map holds its entries', key({ m: new Map([['a', 1]]) }) !== key({ m: new Map([['a', 2]]) }))
ok('a Set holds its values', key({ s: new Set(['a']) }) !== key({ s: new Set(['b']) }))
ok('a span is left out at every depth', key({ a: { b: 1, span: at(1) } }) === key({ a: { b: 1, span: at(9) } }))

const cycle: Record<string, unknown> = { form: 'return' }
cycle.self = cycle
ok('a cycle has no key', key(cycle) === '')
ok('a function has no key', key({ form: 'call', run: () => 1 }) === '')
ok('a class instance has no key', key({ when: new Date(0) }) === '')

// the whole check, the memo full and then empty: every diagnostic and warning the same
const text = `task lift
  take x, like number
  like number
  send back
    call add
      read x
      code 1

task total
  take xs, like list, like number
  like number
  save sum, code 0
  walk size
    bind base, code 0
    bind head
      read xs/length
    hook next
      take site, name i
      save sum
        call add
          read sum
          call lift
            read xs/{i}
  send back, read sum

task third
  take xs, like list, like number
  take n, like number
  like number
  save one, read xs/{n}
  send back, read one
`
const shown = (r: ReturnType<typeof compile>): string =>
  JSON.stringify([r.ok, r.ok ? r.warnings : r.diagnostics], (k, v) => (k === 'span' ? undefined : v))

clearHoldMemo()
const empty = compile({ file: 'memo.tree', text }, {})
ok('the memo keeps the definitions the check met', holdKeyMemoSize() > 0, String(holdKeyMemoSize()))
const full = compile({ file: 'memo.tree', text }, {})
clearHoldMemo()
ok('emptied with the hold memo', holdKeyMemoSize() === 0)
const again = compile({ file: 'memo.tree', text }, {})
ok('the check answers the same with the memo full', shown(full) === shown(empty), shown(full).slice(0, 300))
ok('and empty again', shown(again) === shown(empty))

console.log(`\nhold-key-memo: ${pass} pass, ${fail} fail`)
if (fail) process.exit(1)
