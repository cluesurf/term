// A document cannot loop forever, and cannot take the compiler down trying.
//
// Two graphs, checked in two places. A MACRO cycle is caught before expansion, because expansion is what it
// destroys: `compile/template.ts` recurses on a `fuse`, so a macro that fuses itself overflows the stack and a
// crash is not a diagnostic. A VIEW that places itself is caught after reading, where a component use and a view
// definition are told apart. See note/term/view/05-sandbox.md.

import { parse } from '@term/make/code/parser/tree'
import { readView, viewCycles } from '@term/make/code/compile/view'
import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(what: string, held: boolean, note = ''): void {
  if (held) {
    pass++
    console.log(`ok    ${what}`)
  } else {
    fail++
    console.log(`FAIL  ${what}  ${note}`)
  }
}

function cycles(text: string): string {
  const parsed = parse({ file: 'page.tree', text })

  return parsed.ok
    ? viewCycles(parsed.tree, 'page.tree').map(d => d.message).join(' | ')
    : 'parse fail'
}

ok(
  'a macro that fuses itself is named',
  cycles('tree a\n  hook fuse\n    fuse a\nview page\n  fuse a\n').includes('a fuses a'),
  cycles('tree a\n  hook fuse\n    fuse a\nview page\n  fuse a\n'),
)

ok(
  'a two-macro cycle is named',
  /a fuses b fuses a|b fuses a fuses b/.test(
    cycles('tree a\n  hook fuse\n    fuse b\ntree b\n  hook fuse\n    fuse a\nview page\n  fuse a\n'),
  ),
  cycles('tree a\n  hook fuse\n    fuse b\ntree b\n  hook fuse\n    fuse a\nview page\n  fuse a\n'),
)

ok(
  'a three-macro cycle is named',
  cycles('tree a\n  hook fuse\n    fuse b\ntree b\n  hook fuse\n    fuse c\ntree c\n  hook fuse\n    fuse a\nview page\n  fuse a\n').includes('fuses'),
)

ok(
  'a macro used twice is not a cycle',
  cycles('tree a\n  hook fuse\n    text <x>\ntree b\n  hook fuse\n    fuse a\n    fuse a\nview page\n  fuse b\n') === '',
  cycles('tree a\n  hook fuse\n    text <x>\ntree b\n  hook fuse\n    fuse a\n    fuse a\nview page\n  fuse b\n'),
)

ok(
  'a chain with no cycle is not a cycle',
  cycles('tree a\n  hook fuse\n    text <x>\ntree b\n  hook fuse\n    fuse a\ntree c\n  hook fuse\n    fuse b\nview page\n  fuse c\n') === '',
)

// the compile path refuses it rather than crashing
const roleOf = () => 'view'
const built = compile(
  { file: '/app/page/loop.tree', text: 'tree a\n  hook fuse\n    fuse a\nview page\n  fuse a\n' },
  { roleOf, optimize: false },
)

ok('the compile path refuses a macro cycle instead of crashing', !built.ok)
ok(
  'and names the cycle',
  !built.ok && built.diagnostics.some(d => /a macro cannot fuse itself/.test(d.message)),
  built.ok ? '' : built.diagnostics.map(d => d.message).join(' | '),
)

// a view that places itself
function places(text: string): string {
  const parsed = parse({ file: 'page.tree', text })

  if (!parsed.ok) {
    return 'parse fail'
  }

  const result = readView(parsed.tree, 'page.tree')

  return result.ok ? '' : result.diagnostics.map(d => d.message).join(' | ')
}

ok(
  'a view that places itself is named',
  places('view page\n  view page\n    bind a, text <x>\n').includes('page places page'),
  places('view page\n  view page\n    bind a, text <x>\n'),
)

ok(
  'a two-view cycle is named',
  /one places two places one|two places one places two/.test(
    places('view one\n  view two\n    bind a, text <x>\nview two\n  view one\n    bind a, text <x>\n'),
  ),
  places('view one\n  view two\n    bind a, text <x>\nview two\n  view one\n    bind a, text <x>\n'),
)

ok(
  'a view placing a component it does not define is fine',
  places('view page\n  view text/item\n    bind a, text <x>\n') === '',
  places('view page\n  view text/item\n    bind a, text <x>\n'),
)

ok(
  'one view placing another, once, is fine',
  places('view one\n  text <x>\nview two\n  view one\n') === '',
  places('view one\n  text <x>\nview two\n  view one\n'),
)

// ---- the checker itself is bounded ----
// The walk was EXPONENTIAL on a graph that merely fans out, with no cycle in it at all: 26 macros each fusing the
// next four took 1.6 seconds, and 35 would not have finished. A document could hang the compiler with a handful
// of tiny macros and never approach a node cap, which is threat 5 of the sandbox met by the checker meant to
// enforce it. Names proven acyclic are remembered, so no name is walked twice.

function dense(n: number, fan: number): string {
  const lines: string[] = []

  for (let i = 0; i < n; i++) {
    lines.push(`tree m${i}`)
    lines.push('  hook fuse')

    for (let k = 1; k <= fan && i + k < n; k++) {
      lines.push(`    fuse m${i + k}`)
    }

    if (i + 1 >= n) {
      lines.push('    text <end>')
    }
  }

  lines.push('view page')
  lines.push('  fuse m0')

  return lines.join('\n') + '\n'
}

for (const [n, fan, budget] of [[60, 4, 250], [200, 4, 500]] as [number, number, number][]) {
  const parsed = parse({ file: 'page.tree', text: dense(n, fan) })

  if (!parsed.ok) {
    ok(`a dense acyclic graph of ${n} macros parses`, false)
    continue
  }

  const started = Date.now()
  const found = viewCycles(parsed.tree, 'page.tree')
  const spent = Date.now() - started

  ok(`${n} macros fanning out to ${fan} report no cycle`, found.length === 0)
  ok(`and finish well inside ${budget}ms (took ${spent}ms)`, spent < budget)
}

// and a cycle buried inside a dense graph is still found
const buried = dense(40, 4).replace('tree m39\n  hook fuse\n    text <end>', 'tree m39\n  hook fuse\n    fuse m0')
const parsedBuried = parse({ file: 'page.tree', text: buried })

if (parsedBuried.ok) {
  const found = viewCycles(parsedBuried.tree, 'page.tree')

  ok(
    'a cycle buried in a dense graph is still found',
    found.length > 0 && found.some(d => /cannot fuse itself/.test(d.message)),
    found.map(d => d.message).join(' | ') || 'NOT FOUND',
  )
}

console.log(`\nview-cycle: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
