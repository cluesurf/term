// Every bound the dialect claims has a number, and exceeding one says which cap was hit.
//
// A closed vocabulary stops a document doing what we did not write. It does not stop it doing what we DID write,
// ten million times. See note/term/view/05-sandbox.md.

import { parse } from '@term/make/code/parser/tree'
import { readView } from '@term/make/code/compile/view'
import { VIEW_CAPS } from '@term/make/code/compile/view-cap'

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

// tight caps, so a fixture stays readable. The point is that the number is configurable and the message names it.
const TIGHT = { ...VIEW_CAPS, node: 6, deep: 3, callDeep: 2, callSum: 3, walkDeep: 2, walkSum: 40, find: 2, host: 2, view: 1 }

function check(text: string, caps = TIGHT) {
  const parsed = parse({ file: 'page.tree', text })

  if (!parsed.ok) {
    return { ok: false as const, said: parsed.diagnostics.map(d => d.message).join(' | ') }
  }

  const result = readView(parsed.tree, 'page.tree', undefined, caps)

  return { ok: result.ok, said: result.diagnostics.map(d => d.message).join(' | ') }
}

function caps(what: string, text: string, word: string, use = TIGHT): void {
  const result = check(text, use)

  ok(`caps ${what}`, !result.ok && result.said.includes(word), result.said || '(no diagnostic)')
}

const item = (n: number) => Array.from({ length: n }, () => '  view text/item\n    bind a, text <x>').join('\n')

caps('the node count', `view page\n${item(8)}\n`, 'and the cap is 6')
caps('the tree depth',
  'view page\n  view a/b\n    view a/b\n      view a/b\n        view a/b\n', 'nests 4 deep')
caps('nested calls in one value',
  'view page\n  view a/b\n    bind x\n      call one\n        call two\n          call three\n            text <x>\n',
  'nests 3 calls')
caps('operators in a document',
  `view page\n${Array.from({ length: 4 }, () => '  view a/b\n    bind x\n      call one\n        text <y>').join('\n')}\n`,
  'applies 4 operators')
// the product cap is the tighter of the two here, so raise it to let the DEPTH cap be the one that fires. Both
// bound the same thing from different directions and whichever is lower is the one a document meets first.
caps('nested walks',
  'host l, like text\nview page\n  walk list, read l\n    hook next\n      take site, name a\n      walk list, read a\n        hook next\n          take site, name b\n          walk list, read b\n            hook next\n              take site, name c\n              text <x>\n',
  'nests 3 walks',
  { ...TIGHT, deep: 12, walkSum: 10 ** 12 })
caps('the product of nested counted walks',
  'view page\n  walk size\n    bind base, 0\n    bind head, 9\n    hook next\n      take site, name a\n      walk size\n        bind base, 0\n        bind head, 9\n        hook next\n          take site, name b\n          text <x>\n',
  'build up to 81 nodes')
caps('the query count',
  'find a\n  task <x>\nfind b\n  task <y>\nfind c\n  task <z>\nview page\n  text <x>\n', 'names 3 queries')
caps('the value count',
  'host a, text <x>\nhost b, text <y>\nhost c, text <z>\nview page\n  text <x>\n', 'names 3 values')
caps('the view count',
  'view one\n  text <x>\nview two\n  text <y>\n', 'declares 2 views')

// a document inside every cap reads
const fine = check('host a, text <x>\nview page\n  view text/item\n    bind t, read a\n')

ok('a document inside every cap reads', fine.ok, fine.said)

// the counts are taken AFTER macros expand, which is the whole point
const EXPANDED = `
tree row
  take n, like text
  hook fuse
    view text/item
      bind a, text <{n}>
    view text/item
      bind b, text <{n}>
    view text/item
      bind c, text <{n}>

view page
  fuse row
    bind n, <1>
  fuse row
    bind n, <2>
  fuse row
    bind n, <3>
`

const before = EXPANDED.split('\n').filter(l => /^\s+(view|fuse)\b/.test(l)).length

ok('the document reads as fewer nodes before expansion', before < 9)

// expandTemplates runs before the reader in every real path, so feed it the expanded tree the same way
const parsed = parse({ file: 'page.tree', text: EXPANDED })

if (parsed.ok) {
  const { expandTemplates, collectTemplates } = await import('@term/make/code/compile/template')
  const result = readView(
    expandTemplates(parsed.tree, collectTemplates(parsed.tree)),
    'page.tree',
    undefined,
    TIGHT,
  )

  ok(
    'and is capped on the expanded count, which is what a browser builds',
    !result.ok && result.diagnostics.some(d => /builds 9 nodes and the cap is 6/.test(d.message)),
    result.ok ? 'not capped' : result.diagnostics.map(d => d.message).join(' | '),
  )
}

// the default caps are generous enough for a real document
const real = check(
  `host a, text <x>\nview page\n${item(40)}\n`,
  VIEW_CAPS,
)

ok('the default caps pass a forty-node document', real.ok, real.said)

console.log(`\nview-cap: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
