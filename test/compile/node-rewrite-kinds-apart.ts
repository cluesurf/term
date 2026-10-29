// compile/node-rewrite.tree's `kinds-apart` rule (item term-self-host-001-0353, decision 055 section 1): the kernel's
// own copy of a program, where a form named like a task, a parameter, a top-level host value or `type` is
// `<name>__form` and a task named like a kernel constant `<name>__task`. Each case is held to the answer written here
// AND to the reflective walk it replaces, check/elaborate.ts `kindsApart` in its reference copy
// (tmp/retired/make/check/elaborate-kinds-apart.ts), json-sorted. The last cases hold that the program handed to a
// caller that copies first is not written.
// The port is the live one (deck/make/host/port), or the file NODE_REWRITE_PORT names (a draft's port).
// Run: npx tsx test/compile/node-rewrite-kinds-apart.ts

import { join } from 'node:path'
import { kindsApart } from '../../tmp/retired/make/check/elaborate-kinds-apart'

const TERM = join(import.meta.dirname, '..', '..')
const portPath =
  process.env.NODE_REWRITE_PORT ??
  join(TERM, 'deck/make/host/port/code/compile/node-rewrite.ts')
const port = (await import(portPath)) as {
  rewriteProgram: (block: unknown[], rule: unknown) => unknown[]
  copyProgram?: (value: unknown[]) => unknown[]
}

let pass = 0
let fail = 0

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, one]) => one !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, one]) => [key, sorted(one)]),
    )
  }
  return value
}

const text = (value: unknown): string => JSON.stringify(sorted(value))

function ok(
  name: string,
  got: unknown,
  want: unknown,
  reference: unknown,
): void {
  if (text(got) === text(want) && text(got) === text(reference)) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}\n        port      ${text(got)}\n        expected  ${text(want)}\n        reference ${text(reference)}`,
    )
  }
}

function holds(name: string, good: boolean, detail: unknown): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}\n        ${text(detail)}`)
  }
}

const copy = <T>(value: T): T => structuredClone(value)

// ---- nodes ----

const span = {
  file: '/t.tree',
  start: { line: 1, column: 1, offset: 0 },
  end: { line: 1, column: 2, offset: 1 },
}
type Node = Record<string, unknown>
const v = (name: string): Node => ({ form: 'variable', name, span })
const n = (value: number): Node => ({ form: 'integer', value, span })
const call = (callee: string, ...args: unknown[]): Node => ({
  form: 'call',
  callee: v(callee),
  args,
  span,
})
const back = (value: unknown): Node => ({ form: 'return', value, span })
const named = (name: string, args?: unknown[]): Node => ({
  kind: 'named',
  name,
  ...(args ? { args } : {}),
})
const make = (name: string, fields: [string, unknown][]): Node => ({
  form: 'record',
  name,
  fields: fields.map(([field, value]) => ({ name: field, value })),
  span,
})
const form = (
  name: string,
  fields: [string, unknown][] = [['x', { kind: 'number' }]],
): Node => ({
  form: 'record-type',
  name,
  params: [],
  fields: fields.map(([field, type]) => ({ name: field, type })),
  variants: [],
  span,
})
const task = (
  name: string,
  params: [string, unknown?][],
  body: unknown[],
  extra: Node = {},
): Node => ({
  form: 'function',
  name,
  params: params.map(([one, type]) => ({
    name: one,
    ...(type ? { type } : {}),
  })),
  body,
  generics: [],
  span,
  ...extra,
})
const host = (name: string, init: unknown): Node => ({
  form: 'let',
  name,
  init,
  mutable: false,
  span,
})

// the rule as decision 055 builds it, the port's answer for one program
function rewritten(
  program: Node[],
  forms: string[],
  tasks: string[],
): unknown[] {
  return port.rewriteProgram(copy(program), {
    form: 'kinds-apart',
    forms,
    tasks,
  })
}

function kindsCase(
  name: string,
  program: Node[],
  forms: string[],
  tasks: string[],
  want: Node[],
): void {
  ok(
    `kinds-apart: ${name}`,
    rewritten(program, forms, tasks),
    want,
    kindsApart(copy(program) as never),
  )
}

// a form and a task of one name: the type, the construction and the definition apart, the task and its call kept
kindsCase(
  'a form named like a task',
  [
    form('point'),
    task(
      'point',
      [['x', { kind: 'number' }]],
      [back(make('point', [['x', v('x')]]))],
      { result: named('point') },
    ),
    task(
      'twice',
      [['p', named('point')]],
      [back(call('point', n(2)))],
      { result: named('point') },
    ),
  ],
  ['point'],
  [],
  [
    form('point__form'),
    task(
      'point',
      [['x', { kind: 'number' }]],
      [back(make('point__form', [['x', v('x')]]))],
      { result: named('point__form') },
    ),
    task(
      'twice',
      [['p', named('point__form')]],
      [back(call('point', n(2)))],
      { result: named('point__form') },
    ),
  ],
)

// a parameter named like its form: the parameter and its reads keep their name
kindsCase(
  'a form named like a parameter',
  [
    form('box'),
    task('grow', [['box', named('box')]], [back(v('box'))], {
      result: named('box'),
    }),
  ],
  ['box'],
  [],
  [
    form('box__form'),
    task('grow', [['box', named('box__form')]], [back(v('box'))], {
      result: named('box__form'),
    }),
  ],
)

// a top-level host value named like its form, a list type of the form inside a type argument
kindsCase(
  'a form named like a top-level host value',
  [
    form('non-finite'),
    {
      ...host('non-finite', {
        form: 'array',
        items: [make('non-finite', [['x', n(1)]])],
        span,
      }),
      type: named('list', [named('non-finite')]),
    },
  ],
  ['non-finite'],
  [],
  [
    form('non-finite__form'),
    {
      ...host('non-finite', {
        form: 'array',
        items: [make('non-finite__form', [['x', n(1)]])],
        span,
      }),
      type: named('list', [named('non-finite__form')]),
    },
  ],
)

// a form named `type`: an expression's own type and a match arm's type are entered too
kindsCase(
  'a form named type',
  [
    form('type'),
    task(
      'describe',
      [['t', named('type')]],
      [
        {
          form: 'match',
          subject: { ...v('t'), type: named('type') },
          cases: [{ label: 'type', body: [], type: named('type') }],
          span,
        },
      ],
    ),
  ],
  ['type'],
  [],
  [
    form('type__form'),
    task(
      'describe',
      [['t', named('type__form')]],
      [
        {
          form: 'match',
          subject: { ...v('t'), type: named('type__form') },
          cases: [
            { label: 'type', body: [], type: named('type__form') },
          ],
          span,
        },
      ],
    ),
  ],
)

// a task named like a kernel constant: its definition and every call's variable callee, never a value reference, a
// method of that name, or a callee that is no variable
kindsCase(
  'a task named like a kernel constant, called, passed and shadowed by a method',
  [
    task(
      'equal',
      [['a'], ['b']],
      [back(call('is-equal', v('a'), v('b')))],
    ),
    task(
      'same',
      [['a']],
      [
        back(call('equal', v('a'), v('a'))),
        back(call('keep', v('equal'))),
      ],
    ),
    task('equal', [['a']], [], {
      method: { form: 'point', name: 'equal' },
    }),
    task(
      'member',
      [['p']],
      [
        back({
          form: 'call',
          callee: {
            form: 'member',
            target: v('p'),
            name: 'equal',
            span,
          },
          args: [],
          span,
        }),
      ],
    ),
  ],
  [],
  ['equal'],
  [
    task(
      'equal__task',
      [['a'], ['b']],
      [back(call('is-equal', v('a'), v('b')))],
    ),
    task(
      'same',
      [['a']],
      [
        back(call('equal__task', v('a'), v('a'))),
        back(call('keep', v('equal'))),
      ],
    ),
    task('equal', [['a']], [], {
      method: { form: 'point', name: 'equal' },
    }),
    task(
      'member',
      [['p']],
      [
        back({
          form: 'call',
          callee: {
            form: 'member',
            target: v('p'),
            name: 'equal',
            span,
          },
          args: [],
          span,
        }),
      ],
    ),
  ],
)

// a method's owner and a raise apart, the method's own name kept
kindsCase(
  'a method on a form kept apart, and a raise of it',
  [
    form('shape'),
    task(
      'shape',
      [['side']],
      [back(make('shape', [['x', v('side')]]))],
    ),
    task(
      'shape_area',
      [],
      [
        {
          form: 'throw',
          value: make('shape', [['x', n(0)]]),
          raise: 'shape',
          span,
        },
      ],
      { method: { form: 'shape', name: 'area' } },
    ),
  ],
  ['shape'],
  [],
  [
    form('shape__form'),
    task(
      'shape',
      [['side']],
      [back(make('shape__form', [['x', v('side')]]))],
    ),
    task(
      'shape_area',
      [],
      [
        {
          form: 'throw',
          value: make('shape__form', [['x', n(0)]]),
          raise: 'shape__form',
          span,
        },
      ],
      {
        method: { form: 'shape__form', name: 'area' },
      },
    ),
  ],
)

// a separate build's stub: its carried body and its one-statement shape are entered
{
  const body = [
    back(make('cell-thing', [['x', call('equal', v('a'), v('a'))]])),
  ]
  const stub = task('cell-thing', [['a', named('cell-thing')]], [], {
    stub: true,
    stubBody: body,
    stubShape: body[0],
    result: named('cell-thing'),
  })
  const renamedBody = [
    back(
      make('cell-thing__form', [
        ['x', call('equal__task', v('a'), v('a'))],
      ]),
    ),
  ]
  kindsCase(
    'a stub carrying a body and a shape',
    [
      form('cell-thing'),
      stub,
      task('equal', [['a'], ['b']], [], { stub: true }),
    ],
    ['cell-thing'],
    ['equal'],
    [
      form('cell-thing__form'),
      task('cell-thing', [['a', named('cell-thing__form')]], [], {
        stub: true,
        stubBody: renamedBody,
        stubShape: renamedBody[0],
        result: named('cell-thing__form'),
      }),
      task('equal__task', [['a'], ['b']], [], { stub: true }),
    ],
  )
}

// ---- the caller copies, so the program it was handed is never written ----

{
  const program = [
    form('point'),
    task('point', [['x']], [back(make('point', [['x', v('x')]]))]),
    task('equal', [['a']], [back(call('equal', v('a')))]),
  ]
  const before = text(program)
  const copier =
    port.copyProgram ?? ((value: unknown[]) => structuredClone(value))
  const answer = port.rewriteProgram(copier(program), {
    form: 'kinds-apart',
    forms: ['point'],
    tasks: ['equal'],
  })
  holds(
    'kinds-apart over a copy: the program handed in is unchanged',
    text(program) === before,
    program,
  )
  holds(
    'kinds-apart over a copy: the answer is renamed',
    text(answer).includes('point__form') &&
      text(answer).includes('equal__task'),
    answer,
  )
  holds(
    'kinds-apart over a copy: the answer shares no statement with the input',
    (answer as unknown[]).every((one, at) => one !== program[at]),
    answer,
  )
}

// both lists empty: nothing is renamed (decision 055: the caller hands the program back as given)
{
  const program = [
    form('point'),
    task(
      'move',
      [['p', named('point')]],
      [back(call('equal', v('p')))],
    ),
  ]
  ok(
    'kinds-apart with both lists empty renames nothing',
    rewritten(program, [], []),
    program,
    kindsApart(copy(program) as never),
  )
}

console.log(`\nnode-rewrite-kinds-apart: ${pass} pass, ${fail} fail`)
process.exitCode = fail > 0 ? 1 : 0
