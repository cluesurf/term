// A width word is part of a number's type (note/term/plan/decisions-2026-10.md, D12 a). `like list, like u8` checks as
// an array of a number that carries `u8`, a diagnostic prints it, and nothing is owed or refused yet (width/spec.md
// 3.1). Run: npx tsx test/check/width-type.ts
//
// Each case sits beside its plain twin, so a type that carried a width everywhere, or nowhere, fails here.

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { setWidthRanges } from '@term/make/code/check/width-range'

let pass = 0
let fail = 0

const stdlib = stdlibResolver()!

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`)
  }
}

function build(source: string) {
  return compile({ file: 'w.tree', text: source }, { resolve: withNativeEnv('node', stdlib) })
}

const messages = (result: ReturnType<typeof build>): string => (result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))

// the declared type of the parameter `of` in the task `task`
function paramType(source: string, task: string, of: string): any {
  const result = build(source)

  if (!result.ok) {
    return undefined
  }

  const found = result.program.find((s: any) => s.form === 'function' && s.name === task) as any

  return found?.params.find((p: any) => p.name === of)?.type
}

const LIST = `task first
  take xs, like list, like u8
  take at, like number
  like number
  save got, read xs/{at}
  send back, read got
`

// the type itself
const list = paramType(LIST, 'first', 'xs')
check('list of u8: the element is a number carrying u8', list?.kind === 'array' && list.element.kind === 'number' && list.element.width === 'u8', JSON.stringify(list))
check('list of u16 and i64 keep their own word', paramType(LIST.replace('u8', 'u16'), 'first', 'xs')?.element?.width === 'u16' && paramType(LIST.replace('u8', 'i64'), 'first', 'xs')?.element?.width === 'i64')
check('list of number carries no width', paramType(LIST.replace('like u8', 'like number'), 'first', 'xs')?.element?.width === undefined)
check('list of u128 carries none (no range)', paramType(LIST.replace('like u8', 'like u128'), 'first', 'xs')?.element?.width === undefined)
check('list of size and integer carry none', paramType(LIST.replace('like u8', 'like size'), 'first', 'xs')?.element?.width === undefined && paramType(LIST.replace('like u8', 'like integer'), 'first', 'xs')?.element?.width === undefined)

const scalar = paramType('task one\n  take x, like u8\n  like number\n  send back, read x\n', 'one', 'x')
check('a scalar `like u8` is a number carrying u8', scalar?.kind === 'number' && scalar.width === 'u8', JSON.stringify(scalar))

const nested = paramType('task one\n  take xs, like hash, like text, like list, like i8\n  like number\n  send back, 0\n', 'one', 'xs')
check('a width under a hash value under a list keeps its word', JSON.stringify(nested)?.includes('"width":"i8"'), JSON.stringify(nested))

// the text a diagnostic prints (a) and the plain twin
const wrong = build(`task show
  take xs, like list, like u8
  like text
  send back, read xs
`)
check('a diagnostic names the width: `list, like u8`', !wrong.ok && /list, like u8/.test(messages(wrong)), messages(wrong))

const plain = build(`task show
  take xs, like list, like number
  like text
  send back, read xs
`)
check('the plain twin still says `list, like number`', !plain.ok && /list, like number/.test(messages(plain)), messages(plain))

// nothing is refused: a width passes where a plain number is wanted, and back
const scalarAdd = build(`task bump
  take x, like u8
  like number
  send back
    call add
      read x
      code 1
`)
check('(b) a scalar u8 passed to add(x, 1) builds', scalarAdd.ok, messages(scalarAdd))

const readOut = build(`task wanted
  take n, like number
  like number
  send back, read n

task run
  take xs, like list, like u8
  like number
  save got, read xs/0
  send back
    call wanted
      read got
`)
check('(c) an element of a list of u8 passed to a like-number parameter builds', readOut.ok, messages(readOut))

const generic = build(`load @term/base/list
  find get

task run
  take xs, like list, like u8
  like number
  save got, get(xs, 0)
  send back, read got
`)
check('(d) a generic get over a list of u8 builds', generic.ok, messages(generic))

// a list's element width is invariant (0002): with the switch on, in both directions; off, nothing is refused
function buildWith(source: string, ranges: boolean) {
  setWidthRanges(ranges)

  try {
    return build(source)
  } finally {
    setWidthRanges(false)
  }
}

const wantsU8 = (element: string, own: string) => `task wants
  take xs, like list, like u8
  like number
  send back, 0

task run
  take ys, like list, like ${own}
  like number
  send back
    call wants
      read ys
`.replace('like u8', `like ${element}`)

const numberForU8 = buildWith(wantsU8('u8', 'number'), true)
check('(e) a list of number where a list of u8 is wanted is refused, on', !numberForU8.ok && /a list of number where a list of u8 is wanted: type the source as u8, or convert each element with to-u8/.test(messages(numberForU8)), messages(numberForU8))

const u8ForNumber = buildWith(wantsU8('number', 'u8'), true)
check('(f) a list of u8 where a list of number is wanted is refused, on', !u8ForNumber.ok && /a list of u8 where a list of number is wanted/.test(messages(u8ForNumber)), messages(u8ForNumber))

const offA = buildWith(wantsU8('u8', 'number'), false)
const offB = buildWith(wantsU8('number', 'u8'), false)
check('(g) both build with the switch off', offA.ok && offB.ok, messages(offA) + messages(offB))

const sameWidth = buildWith(wantsU8('u8', 'u8'), true)
check('(h) a list of u8 to a list of u8 builds, on', sameWidth.ok, messages(sameWidth))

const plainPair = buildWith(wantsU8('number', 'number'), true)
check('(h2) a list of number to a list of number builds, on', plainPair.ok, messages(plainPair))

const pushed = buildWith(
  `load @term/base/list
  find push

task wants
  take xs, like list, like u8
  like number
  send back, 0

task run
  take v, like u8
  like number
  save made, make list
  push(made, v)
  send back
    call wants
      read made
`,
  true,
)
check('(i) a make list pushed u8 values, passed to a list of u8, builds (the variable binds u8)', pushed.ok, messages(pushed))

const scalarOn = buildWith(
  `task bump
  take x, like u8
  take y, like number
  like number
  send back
    call add
      read x
      read y
`,
  true,
)
check('(j) scalars still mix, on', scalarOn.ok, messages(scalarOn))

console.log(`\n${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
