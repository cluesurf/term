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

console.log(`\nview-cycle: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
