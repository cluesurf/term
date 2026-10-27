// compile/node-rewrite.tree's rules for the mint bridge's writing walks (item term-self-host-001-0302, decision 043):
// `rename-local` and its scope guard, `apply-aliases`, `free-alias-targets`. Each case is held to the answer written
// here AND to the reflective walk it replaces in the reference copy of mint-bridge.ts
// (tmp/retired/make/compile/mint-bridge-minting.ts: renameLocal, applyAliases, freeAliasTargets), json-sorted.
// The port is the live one (deck/make/host/port), or the file NODE_REWRITE_PORT names (a draft's port).
// Run: npx tsx test/compile/node-rewrite-scope.ts

import { join } from 'node:path'
import * as original from '../../tmp/retired/make/compile/mint-bridge-minting'

const TERM = join(import.meta.dirname, '..', '..')
const portPath = process.env.NODE_REWRITE_PORT ?? join(TERM, 'deck/make/host/port/code/compile/node-rewrite.ts')
const port = (await import(portPath)) as {
  rewriteBlock?: (block: unknown[], rule: unknown) => unknown[]
  rewriteProgram: (block: unknown[], rule: unknown) => unknown[]
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

function ok(name: string, got: unknown, want: unknown, reference: unknown): void {
  const holds = text(got) === text(want) && text(got) === text(reference)
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}\n        port      ${text(got)}\n        expected  ${text(want)}\n        reference ${text(reference)}`)
  }
}

const copy = <T>(value: T): T => structuredClone(value)

// ---- nodes ----

const span = { file: '/t.tree', start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 2, offset: 1 } }
const v = (name: string): Record<string, unknown> => ({ form: 'variable', name, span })
const n = (value: number): Record<string, unknown> => ({ form: 'integer', value, span })
const call = (callee: string, ...args: unknown[]): Record<string, unknown> => ({ form: 'call', callee: v(callee), args, span })
const say = (expr: unknown): Record<string, unknown> => ({ form: 'expression', expr, span })
const let_ = (name: string, init: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  form: 'let',
  name,
  init,
  mutable: false,
  span,
  ...extra,
})
const closure = (params: string[], body: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  form: 'closure',
  params: params.map(name => ({ name })),
  body,
  span,
  ...extra,
})
const task = (name: string, params: string[], body: unknown[]): Record<string, unknown> => ({
  form: 'function',
  name,
  params: params.map(one => ({ name: one })),
  body,
  generics: [],
  span,
})
const each = (item: string, iterable: unknown, body: unknown[], index?: string): Record<string, unknown> => ({
  form: 'for-each',
  item,
  ...(index === undefined ? {} : { index }),
  iterable,
  body,
  span,
})
const named = (name: string, valueArgs?: unknown[]): Record<string, unknown> => ({
  kind: 'named',
  name,
  ...(valueArgs ? { valueArgs } : {}),
})

// ---- rename-local ----

function renamePort(block: unknown[], from: string, to: string): unknown[] {
  return port.rewriteProgram(copy(block), { form: 'rename-local', from, to })
}

function renameCase(name: string, block: unknown[], from: string, to: string, want: unknown[]): void {
  ok(`rename-local: ${name}`, renamePort(block, from, to), want, original.renameLocal(copy(block), from, to))
}

renameCase('a free read and write', [let_('y', v('x')), say(call('f', v('x'), v('y')))], 'x', 'x__1', [
  let_('y', v('x__1')),
  say(call('f', v('x__1'), v('y'))),
])

renameCase('a closure whose parameter rebinds the name is left whole', [say(closure(['x'], [say(v('x'))])), say(v('x'))], 'x', 'z', [
  say(closure(['x'], [say(v('x'))])),
  say(v('z')),
])

renameCase('a closure over other names is entered', [say(closure(['a'], [say(v('x'))]))], 'x', 'z', [
  say(closure(['a'], [say(v('z'))])),
])

renameCase('a task whose parameter rebinds the name is left whole', [task('t', ['x'], [say(v('x'))]), say(v('x'))], 'x', 'z', [
  task('t', ['x'], [say(v('x'))]),
  say(v('z')),
])

renameCase('a walk binding the name as its item is left whole, iterable too', [each('x', v('x'), [say(v('x'))]), say(v('x'))], 'x', 'z', [
  each('x', v('x'), [say(v('x'))]),
  say(v('z')),
])

renameCase('a walk binding the name as its index is left whole', [each('i', v('x'), [say(v('x'))], 'x')], 'x', 'z', [
  each('i', v('x'), [say(v('x'))], 'x'),
])

renameCase('a walk over other names is entered', [each('i', v('x'), [say(v('x'))])], 'x', 'z', [
  each('i', v('z'), [say(v('z'))]),
])

const arms = (subject: unknown, first: unknown[], second: unknown[]): Record<string, unknown> => ({
  form: 'match',
  subject,
  cases: [
    { label: 'some', body: first, binds: ['x'] },
    { label: 'none', body: second },
  ],
  span,
})

renameCase('a match arm binding the name is left whole, the other arm and the subject renamed', [arms(v('x'), [say(v('x'))], [say(v('x'))])], 'x', 'z', [
  arms(v('z'), [say(v('x'))], [say(v('z'))]),
])

const guard = (body: unknown[], name: string, handler: unknown[]): Record<string, unknown> => ({
  form: 'guard',
  body,
  catch: { name, body: handler, span },
  span,
})

renameCase('a handler catching the name is left whole, the guarded body renamed', [guard([say(v('x'))], 'x', [say(v('x'))])], 'x', 'z', [
  guard([say(v('z'))], 'x', [say(v('x'))]),
])

renameCase('a handler catching another name is entered', [guard([say(v('x'))], 'e', [say(v('x'))])], 'x', 'z', [
  guard([say(v('z'))], 'e', [say(v('z'))]),
])

renameCase(
  'a value index of a closure result is renamed, an expression type never',
  [say(closure([], [], { result: named('vec', [v('x')]), type: named('vec', [v('x')]) }))],
  'x',
  'z',
  [say(closure([], [], { result: named('vec', [v('z')]), type: named('vec', [v('x')]) }))],
)

// ---- apply-aliases ----

function aliasCase(name: string, block: unknown[], aliases: [string, string][], want: unknown[]): void {
  const map = new Map(aliases)
  const reference = copy(block)
  original.applyAliases(map, reference as never)
  ok(`apply-aliases: ${name}`, port.rewriteProgram(copy(block), { form: 'apply-aliases', aliases: map }), want, reference)
}

aliasCase('a variable, a construction and a named type', [
  let_('a', { form: 'record', name: 'el', fields: [{ name: 'k', value: v('get') }], span }, { type: named('el') }),
], [['get', 'list-get'], ['el', 'chart-element']], [
  let_('a', { form: 'record', name: 'chart-element', alias: 'el', fields: [{ name: 'k', value: { ...v('list-get'), alias: 'get' } }], span }, {
    type: { ...named('chart-element'), alias: 'el' },
  }),
])

aliasCase('an expression type and a match arm type', [
  {
    form: 'match',
    subject: { ...v('s'), type: named('el') },
    cases: [{ label: 'el', body: [], type: named('el') }],
    span,
  },
], [['el', 'chart-element']], [
  {
    form: 'match',
    subject: { ...v('s'), type: { ...named('chart-element'), alias: 'el' } },
    cases: [{ label: 'el', body: [], type: { ...named('chart-element'), alias: 'el' } }],
    span,
  },
])

aliasCase('a lean call whose label is an alias notes it, a plain call does not', [
  say({ ...call('f', n(1), n(2)), lean: true, names: ['', 'get'] }),
  say({ ...call('f', n(1)), lean: true, names: ['k'] }),
  say({ ...call('f', n(1)), names: ['get'] }),
], [['get', 'list-get']], [
  say({ ...call('f', n(1), n(2)), lean: true, names: ['', 'get'], leanAliases: ['', 'list-get'] }),
  say({ ...call('f', n(1)), lean: true, names: ['k'] }),
  say({ ...call('f', n(1)), names: ['get'] }),
])

// ---- free-alias-targets ----

function freeCase(name: string, block: unknown[], aliases: [string, string][], want: unknown[], count: number): void {
  const map = new Map(aliases)
  const bridge = { aliases: map, shadows: 0 }
  const reference = copy(block)
  original.freeAliasTargets(bridge as never, reference as never)
  const fresh = { count: 0 }
  const targets = new Map([...map.values()].map(target => [target, true]))
  const got = port.rewriteProgram(copy(block), { form: 'free-alias-targets', aliases: map, targets, fresh })
  ok(`free-alias-targets: ${name}`, { program: got, count: fresh.count }, { program: want, count }, { program: reference, count: bridge.shadows })
}

freeCase(
  'a let named like a target whose rest reads an alias, then a second one',
  [let_('root', call('project-root')), say(v('root')), let_('root', n(1)), say(call('project-root'))],
  [['project-root', 'root']],
  [let_('root__1', call('project-root')), say(v('root__1')), let_('root__2', n(1)), say(call('project-root'))],
  2,
)

freeCase(
  'a let named like a target that reads no alias is left',
  [let_('root', n(1)), say(v('root'))],
  [['project-root', 'root']],
  [let_('root', n(1)), say(v('root'))],
  0,
)

freeCase(
  'a closure parameter and a walk item, numbered in the order met',
  [
    say(closure(['root'], [say(call('project-root')), say(v('root'))])),
    each('root', v('xs'), [say(call('project-root'))]),
  ],
  [['project-root', 'root']],
  [
    say(closure(['root__1'], [say(call('project-root')), say(v('root__1'))])),
    each('root__2', v('xs'), [say(call('project-root'))]),
  ],
  2,
)

freeCase(
  'a nested let inside a renamed scope is numbered before the next statement',
  [
    let_('root', closure([], [let_('root', call('project-root')), say(v('root'))])),
    say(call('project-root')),
    say(v('root')),
  ],
  [['project-root', 'root']],
  [
    let_('root__1', closure([], [let_('root__2', call('project-root')), say(v('root__2'))])),
    say(call('project-root')),
    say(v('root__1')),
  ],
  2,
)

console.log(`\nnode-rewrite-scope: ${pass} pass, ${fail} fail`)
process.exitCode = fail > 0 ? 1 : 0
