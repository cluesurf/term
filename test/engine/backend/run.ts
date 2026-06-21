// Validate the TypeScript backend: compile vibe programs to TS, run the compiled version, and confirm it computes
// the SAME result as the interpreter (the oracle). Run: pnpm call test/machine/backend/run.ts

import type {
  Expression,
  Statement,
  BinaryOp,
} from '@cluesurf/make/code/engine/ast'
import { run, callFunction } from '@cluesurf/make/code/engine/engine'
import {
  runCompiled,
  runCompiledFunction,
} from '@cluesurf/make/code/engine/backend/typescript'
import { display, type Value } from '@cluesurf/make/code/engine/value'

const int = (value: number): Expression => ({ form: 'integer', value })
const str = (value: string): Expression => ({ form: 'string', value })
const vbl = (name: string): Expression => ({ form: 'variable', name })
const bin = (
  op: BinaryOp,
  left: Expression,
  right: Expression,
): Expression => ({ form: 'binary', op, left, right })
const call = (name: string, ...args: Expression[]): Expression => ({
  form: 'call',
  callee: vbl(name),
  args,
})
const lett = (name: string, e: Expression): Statement => ({
  form: 'let',
  name,
  init: e,
  mutable: true,
})
const set = (name: string, e: Expression): Statement => ({
  form: 'assign',
  target: vbl(name),
  op: '=',
  value: e,
})
const ret = (e: Expression): Statement => ({ form: 'return', value: e })
const fn = (
  name: string,
  params: string[],
  body: Statement[],
  isAsync = false,
): Statement => ({ form: 'function', name, params, body, isAsync })
const arg = (v: bigint): Value => ({
  form: 'integer',
  value: { value: v, resolution: 'big' },
})

let pass = 0,
  fail = 0
async function same(
  name: string,
  interp: Promise<Value>,
  compiled: Promise<Value>,
): Promise<void> {
  const a = display(await interp),
    b = display(await compiled)
  if (a === b) {
    pass++
    console.log(`ok    ${name}  (= ${a})`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (interpreter ${a}, compiled ${b})`)
  }
}

async function main(): Promise<void> {
  const fibProg: Statement[] = [
    fn(
      'fib',
      ['n'],
      [
        lett('a', int(0)),
        lett('b', int(1)),
        lett('t', int(0)),
        {
          form: 'while',
          cond: bin('!=', vbl('n'), int(0)),
          body: [
            set('n', bin('-', vbl('n'), int(1))),
            set('t', bin('+', vbl('a'), vbl('b'))),
            set('a', vbl('b')),
            set('b', vbl('t')),
          ],
        },
        ret(vbl('a')),
      ],
    ),
  ]
  await same(
    'fib(10) while loop',
    callFunction(fibProg, 'fib', [arg(10n)]),
    runCompiledFunction(fibProg, 'fib', [arg(10n)]),
  )

  const factProg: Statement[] = [
    fn(
      'fact',
      ['n'],
      [
        {
          form: 'if',
          branches: [
            { cond: bin('<=', vbl('n'), int(1)), body: [ret(int(1))] },
          ],
          otherwise: [
            ret(
              bin(
                '*',
                vbl('n'),
                call('fact', bin('-', vbl('n'), int(1))),
              ),
            ),
          ],
        },
      ],
    ),
  ]
  await same(
    'fact(6) recursion',
    callFunction(factProg, 'fact', [arg(6n)]),
    runCompiledFunction(factProg, 'fact', [arg(6n)]),
  )

  const classifyProg: Statement[] = [
    fn(
      'classify',
      ['n'],
      [
        {
          form: 'switch',
          subject: call('sign', vbl('n')),
          cases: [
            { match: int(-1), body: [ret(str('negative'))] },
            { match: int(0), body: [ret(str('zero'))] },
          ],
          otherwise: [ret(str('positive'))],
        },
      ],
    ),
    fn(
      'sign',
      ['n'],
      [
        {
          form: 'if',
          branches: [
            { cond: bin('<', vbl('n'), int(0)), body: [ret(int(-1))] },
            { cond: bin('>', vbl('n'), int(0)), body: [ret(int(1))] },
          ],
          otherwise: [ret(int(0))],
        },
      ],
    ),
  ]
  await same(
    'switch classify(-3)',
    callFunction(classifyProg, 'classify', [arg(-3n)]),
    runCompiledFunction(classifyProg, 'classify', [arg(-3n)]),
  )
  await same(
    'switch classify(9)',
    callFunction(classifyProg, 'classify', [arg(9n)]),
    runCompiledFunction(classifyProg, 'classify', [arg(9n)]),
  )

  const arrProg: Statement[] = [
    lett('xs', {
      form: 'array',
      items: [int(2), int(3), int(5), int(7)],
    }),
    set('xs', call('push', vbl('xs'), int(11))),
    lett('sum', int(0)),
    lett('i', int(0)),
    {
      form: 'while',
      cond: bin('<', vbl('i'), {
        form: 'member',
        target: vbl('xs'),
        name: 'length',
      }),
      body: [
        set(
          'sum',
          bin('+', vbl('sum'), {
            form: 'index',
            target: vbl('xs'),
            index: vbl('i'),
          }),
        ),
        set('i', bin('+', vbl('i'), int(1))),
      ],
    },
    { form: 'expression', expr: vbl('sum') },
  ]
  await same('arrays push + sum', run(arrProg), runCompiled(arrProg))

  const mapProg: Statement[] = [
    lett('m', { form: 'map', entries: [] }),
    {
      form: 'assign',
      target: { form: 'member', target: vbl('m'), name: 'a' },
      op: '=',
      value: int(10),
    },
    {
      form: 'assign',
      target: { form: 'member', target: vbl('m'), name: 'b' },
      op: '=',
      value: int(20),
    },
    {
      form: 'expression',
      expr: bin(
        '+',
        { form: 'member', target: vbl('m'), name: 'a' },
        { form: 'member', target: vbl('m'), name: 'b' },
      ),
    },
  ]
  await same('maps fields', run(mapProg), runCompiled(mapProg))

  const strProg: Statement[] = [
    lett('s', bin('+', str('hyper'), str('bolic'))),
    {
      form: 'expression',
      expr: { form: 'member', target: vbl('s'), name: 'length' },
    },
  ]
  await same(
    'strings concat length',
    run(strProg),
    runCompiled(strProg),
  )

  const asyncProg: Statement[] = [
    fn('inner', [], [ret(int(21))], true),
    fn(
      'outer',
      [],
      [
        lett('x', { form: 'await', expr: call('inner') }),
        lett('y', { form: 'await', expr: call('inner') }),
        ret(bin('+', vbl('x'), vbl('y'))),
      ],
      true,
    ),
  ]
  await same(
    'async/await outer()',
    callFunction(asyncProg, 'outer', []),
    runCompiledFunction(asyncProg, 'outer', []),
  )

  // throw + try/catch: a thrown Value is recovered by the catch binding
  const tryProg: Statement[] = [
    fn(
      'safe',
      ['n'],
      [
        {
          form: 'try',
          body: [
            {
              form: 'if',
              branches: [
                {
                  cond: bin('<', vbl('n'), int(0)),
                  body: [{ form: 'throw', value: int(99) }],
                },
              ],
            },
            ret(vbl('n')),
          ],
          catchName: 'e',
          catchBody: [ret(vbl('e'))],
        },
      ],
    ),
  ]
  await same(
    'try/catch recovers a thrown value (n=-5)',
    callFunction(tryProg, 'safe', [arg(-5n)]),
    runCompiledFunction(tryProg, 'safe', [arg(-5n)]),
  )
  await same(
    'try/catch passes through (n=7)',
    callFunction(tryProg, 'safe', [arg(7n)]),
    runCompiledFunction(tryProg, 'safe', [arg(7n)]),
  )

  // for-of over an array sums its elements
  const forProg: Statement[] = [
    fn(
      'total',
      [],
      [
        lett('sum', int(0)),
        {
          form: 'for',
          name: 'x',
          iterable: {
            form: 'array',
            items: [int(1), int(2), int(3), int(4)],
          },
          body: [set('sum', bin('+', vbl('sum'), vbl('x')))],
        },
        ret(vbl('sum')),
      ],
    ),
  ]
  await same(
    'for-of array sum',
    callFunction(forProg, 'total', []),
    runCompiledFunction(forProg, 'total', []),
  )

  console.log(
    `\nbackend (TypeScript): ${pass} pass, ${fail} fail  (compiled output matches the interpreter)`,
  )
}

main()
