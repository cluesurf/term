// A width word is part of a number's type (note/term/plan/decisions-2026-10.md, D12 a). `like list, like u8` checks as
// an array of a number that carries `u8`, a diagnostic prints it, and nothing is owed or refused yet (width/spec.md
// 3.1). Run: npx tsx test/check/width-type.ts
//
// Each case sits beside its plain twin, so a type that carried a width everywhere, or nowhere, fails here.

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

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

console.log(`\n${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
