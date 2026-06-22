// drop-safe analysis tests: which heap locals are single-owner (every use borrows) and so safe to drop once at exit.
// Run: npx tsx test/ir/drop-safe.ts. Uses hand-built ASTs so the cases are exact and independent of surface syntax.

import type { Statement } from '@cluesurf/make/code/compile/node'
import { dropSafeHeapLocals } from '@cluesurf/make/code/ir/drop-safe'

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

const sp = {
  start: { line: 0, column: 0 },
  end: { line: 0, column: 0 },
}
const strType = { kind: 'string' as const }

const str = (): Statement extends never
  ? never
  : Record<string, unknown> =>
  ({ form: 'string', value: 'x', span: sp, type: strType }) as never
const intLit = (): unknown => ({ form: 'integer', value: 0, span: sp })
const v = (name: string): unknown => ({
  form: 'variable',
  name,
  span: sp,
  type: strType,
})
const letHeap = (name: string): unknown => ({
  form: 'let',
  name,
  init: str(),
  mutable: false,
  span: sp,
  type: strType,
})
const fn = (
  body: unknown[],
): Extract<Statement, { form: 'function' }> =>
  ({
    form: 'function',
    name: 'f',
    params: [],
    body,
    generics: [],
    span: sp,
  }) as never

function safe(body: unknown[]): string[] {
  return [...dropSafeHeapLocals(fn(body))]
}

function main(): void {
  ok(
    'an unused heap local is drop-safe',
    safe([
      letHeap('s'),
      { form: 'return', value: intLit(), span: sp },
    ]).join() === 's',
  )

  ok(
    'a returned heap local is NOT drop-safe (moved out)',
    safe([letHeap('s'), { form: 'return', value: v('s'), span: sp }])
      .length === 0,
  )

  ok(
    'a heap local passed to a call is NOT drop-safe (consumed)',
    safe([
      letHeap('s'),
      {
        form: 'expression',
        expr: {
          form: 'call',
          callee: v('use'),
          args: [v('s')],
          span: sp,
        },
        span: sp,
      },
    ]).length === 0,
  )

  ok(
    'a heap local aliased into another binding is NOT drop-safe',
    safe([
      letHeap('s'),
      {
        form: 'let',
        name: 'y',
        init: v('s'),
        mutable: false,
        span: sp,
        type: strType,
      },
      { form: 'return', value: intLit(), span: sp },
    ]).filter(n => n === 's').length === 0,
  )

  ok(
    'a heap local used only as a method receiver is drop-safe (borrow)',
    safe([
      letHeap('s'),
      {
        form: 'expression',
        expr: {
          form: 'call',
          callee: {
            form: 'member',
            target: v('s'),
            name: 'size',
            span: sp,
          },
          args: [],
          span: sp,
        },
        span: sp,
      },
      { form: 'return', value: intLit(), span: sp },
    ]).join() === 's',
  )

  console.log(`\ndrop-safe: ${pass} pass, ${fail} fail`)
}

main()
