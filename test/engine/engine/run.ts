// Tests for the imperative vibe engine. Builds AST programs (a parser comes later) and runs them.
// Run: pnpm call test/machine/engine/run.ts

import type {
  Expression,
  Statement,
} from '@cluesurf/make/code/engine/ast'
import { run, callFunction } from '@cluesurf/make/code/engine/engine'
import { display, type Value } from '@cluesurf/make/code/engine/value'

// tiny AST builders
const int = (value: number): Expression => ({ form: 'integer', value })
const str = (value: string): Expression => ({ form: 'string', value })
const vbl = (name: string): Expression => ({ form: 'variable', name })
const bin = (
  op: import('@cluesurf/make/code/engine/ast').BinaryOp,
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

let pass = 0,
  fail = 0
async function check(
  name: string,
  got: Promise<Value> | Value,
  want: string,
): Promise<void> {
  const v = await got
  const g = display(v)
  if (g === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${g}, want ${want})`)
  }
}

async function main(): Promise<void> {
  // imperative fib via a while loop
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
  await check(
    'while loop: fib(10)',
    callFunction(fibProg, 'fib', [
      { form: 'integer', value: { value: 10n, resolution: 'big' } },
    ]),
    '55',
  )

  // recursion + if/else
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
  await check(
    'recursion + if/else: fact(5)',
    callFunction(factProg, 'fact', [
      { form: 'integer', value: { value: 5n, resolution: 'tri8' } },
    ]),
    '120',
  )

  // switch with fall-through + default
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
  await check(
    'switch: classify(-7)',
    callFunction(classifyProg, 'classify', [
      { form: 'integer', value: { value: -7n, resolution: 'tri8' } },
    ]),
    'negative',
  )
  await check(
    'switch default: classify(7)',
    callFunction(classifyProg, 'classify', [
      { form: 'integer', value: { value: 7n, resolution: 'tri8' } },
    ]),
    'positive',
  )

  // arrays: build, push, sum via while + index + length
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
  await check('arrays: push + sum', run(arrProg), '28')

  // maps: set fields, read back
  const mapProg: Statement[] = [
    lett('m', { form: 'map', entries: [] }),
    {
      form: 'assign',
      target: { form: 'member', target: vbl('m'), name: 'alpha' },
      op: '=',
      value: int(1),
    },
    {
      form: 'assign',
      target: { form: 'member', target: vbl('m'), name: 'beta' },
      op: '=',
      value: int(2),
    },
    {
      form: 'expression',
      expr: bin(
        '+',
        { form: 'member', target: vbl('m'), name: 'alpha' },
        { form: 'member', target: vbl('m'), name: 'beta' },
      ),
    },
  ]
  await check('maps: set + get fields', run(mapProg), '3')

  // strings: concat + length
  const strProg: Statement[] = [
    lett('s', bin('+', str('hyper'), str('bolic'))),
    {
      form: 'expression',
      expr: { form: 'member', target: vbl('s'), name: 'length' },
    },
  ]
  await check('strings: concat length', run(strProg), '10')

  // async / await: an async function awaiting two async calls
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
  await check(
    'async/await: outer()',
    callFunction(asyncProg, 'outer', []),
    '42',
  )

  // for-each over an array, summing
  const forProg: Statement[] = [
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
    { form: 'expression', expr: vbl('sum') },
  ]
  await check('for-each: sum 1..4', run(forProg), '10')

  // for-each with break
  const forBreakProg: Statement[] = [
    lett('sum', int(0)),
    {
      form: 'for',
      name: 'x',
      iterable: call('range', int(0), int(100)),
      body: [
        {
          form: 'if',
          branches: [
            {
              cond: bin('>', vbl('x'), int(5)),
              body: [{ form: 'break' }],
            },
          ],
        },
        set('sum', bin('+', vbl('sum'), vbl('x'))),
      ],
    },
    { form: 'expression', expr: vbl('sum') },
  ]
  await check('for-each + break over range', run(forBreakProg), '15')

  // try / catch / throw: catch a thrown value
  const tryProg: Statement[] = [
    lett('out', str('none')),
    {
      form: 'try',
      body: [
        { form: 'throw', value: str('boom') },
        set('out', str('unreached')),
      ],
      catchName: 'e',
      catchBody: [set('out', vbl('e'))],
    },
    { form: 'expression', expr: vbl('out') },
  ]
  await check('try/catch: catches throw', run(tryProg), 'boom')

  // throw from inside a called function, caught by the caller
  const tryCallProg: Statement[] = [
    fn('bad', [], [{ form: 'throw', value: str('inner') }]),
    fn(
      'safe',
      [],
      [
        {
          form: 'try',
          body: [
            { form: 'expression', expr: call('bad') },
            ret(str('ok')),
          ],
          catchName: 'e',
          catchBody: [ret(vbl('e'))],
        },
      ],
    ),
  ]
  await check(
    'try/catch: across a call',
    callFunction(tryCallProg, 'safe', []),
    'inner',
  )

  // finally always runs
  const finallyProg: Statement[] = [
    lett('log', str('')),
    {
      form: 'try',
      body: [{ form: 'throw', value: str('x') }],
      catchName: 'e',
      catchBody: [set('log', bin('+', vbl('log'), str('c')))],
      finallyBody: [set('log', bin('+', vbl('log'), str('f')))],
    },
    { form: 'expression', expr: vbl('log') },
  ]
  await check('try: finally runs after catch', run(finallyProg), 'cf')

  // stdlib: range + map + filter + reduce
  const lam = (params: string[], body: Statement[]): Expression => ({
    form: 'closure',
    params,
    body,
  })
  const pipelineProg: Statement[] = [
    lett('xs', call('range', int(1), int(6))), // [1,2,3,4,5]
    lett(
      'doubled',
      call(
        'map',
        vbl('xs'),
        lam(['x'], [ret(bin('*', vbl('x'), int(2)))]),
      ),
    ),
    lett(
      'evens',
      call(
        'filter',
        vbl('doubled'),
        lam(
          ['x'],
          [ret(bin('==', bin('%', vbl('x'), int(4)), int(0)))],
        ),
      ),
    ), // [4,8]
    {
      form: 'expression',
      expr: call(
        'reduce',
        vbl('evens'),
        lam(['a', 'b'], [ret(bin('+', vbl('a'), vbl('b')))]),
        int(0),
      ),
    },
  ]
  await check(
    'stdlib: range/map/filter/reduce',
    run(pipelineProg),
    '12',
  )

  // stdlib: string + sort
  await check(
    'stdlib: upper',
    run([{ form: 'expression', expr: call('upper', str('vibe')) }]),
    'VIBE',
  )
  await check(
    'stdlib: join',
    run([
      {
        form: 'expression',
        expr: call(
          'join',
          { form: 'array', items: [str('a'), str('b'), str('c')] },
          str('-'),
        ),
      },
    ]),
    'a-b-c',
  )
  await check(
    'stdlib: sort',
    run([
      {
        form: 'expression',
        expr: call('sort', {
          form: 'array',
          items: [int(3), int(1), int(2)],
        }),
      },
    ]),
    '[1, 2, 3]',
  )
  await check(
    'stdlib: max',
    run([{ form: 'expression', expr: call('max', int(4), int(9)) }]),
    '9',
  )
  await check(
    'stdlib: abs',
    run([{ form: 'expression', expr: call('abs', int(-12)) }]),
    '12',
  )

  console.log(`\nengine: ${pass} pass, ${fail} fail`)
}

main()
