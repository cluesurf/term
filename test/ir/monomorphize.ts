// Monomorphization tests: a generic function called at two concrete types becomes two specialized functions, the
// generic original is dropped, and the calls are rewritten. Run: npx tsx test/ir/monomorphize.ts

import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import { resolve } from '@/code/check/resolve'
import { check } from '@/code/check/infer'
import { monomorphize } from '@/code/ir/monomorphize'
import type { Program } from '@/code/compile/node'

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

function frontEnd(text: string): Program {
  const parsed = parse({ file: 'm.tree', text })
  if (!parsed.ok) throw new Error('parse failed')
  const built = mill(parsed.tree, 'm.tree')
  if (!built.ok) throw new Error('mill failed')
  resolve(built.program, 'm.tree')
  check(built.program, 'm.tree')
  return built.program
}

const SOURCE = `task identity
  head t
  take x, like t
  like t
  send back x

task run-number
  like number
  send back
    call identity
      code 1

task run-string
  like text
  send back
    call identity
      text <hi>
`

function functionNames(program: Program): Array<string> {
  return program
    .filter(s => s.form === 'function')
    .map(s => (s as { name: string }).name)
}

function main(): void {
  const result = monomorphize(frontEnd(SOURCE))
  const names = functionNames(result)

  ok(
    'the generic original is dropped',
    !names.includes('identity'),
    names.join(','),
  )
  ok(
    'specialized at number',
    names.includes('identity__number'),
    names.join(','),
  )
  ok(
    'specialized at string',
    names.includes('identity__string'),
    names.join(','),
  )

  // the specialized identity__number has a concrete number parameter (no generic name)
  const spec = result.find(
    s => s.form === 'function' && s.name === 'identity__number',
  )
  ok(
    'specialization has a concrete param type',
    spec !== undefined &&
      spec.form === 'function' &&
      spec.params[0]!.type?.kind === 'number',
  )
  ok(
    'specialization has no generics',
    spec !== undefined &&
      spec.form === 'function' &&
      spec.generics.length === 0,
  )

  // the call in run-number was rewritten to the specialized name
  const runNumber = result.find(
    s => s.form === 'function' && s.name === 'run-number',
  )
  let rewritten = false
  if (runNumber && runNumber.form === 'function') {
    const ret = runNumber.body.find(b => b.form === 'return')
    if (
      ret &&
      ret.form === 'return' &&
      ret.value?.form === 'call' &&
      ret.value.callee.form === 'variable'
    ) {
      rewritten = ret.value.callee.name === 'identity__number'
    }
  }
  ok('the call site is rewritten to the specialization', rewritten)

  console.log(`\nmonomorphize: ${pass} pass, ${fail} fail`)
}

main()
