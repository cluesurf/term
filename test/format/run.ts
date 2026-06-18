// Formatter tests: canonical layout, idempotence, comment preservation, and (above all) meaning preservation.
// Run: npx tsx test/format/run.ts

import { format } from '@/code/format/format'
import { parse } from '@/code/parser/tree'

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

// a structural fingerprint, ignoring layout and comments, to prove the formatter never changes meaning
function shape(node: { kind: string; nodes?: Array<unknown>; parts?: Array<{ kind: string; text?: string }>; value?: unknown; token?: { text: string } }): string {
  if (node.kind === 'group' || node.kind === 'root') return `${node.kind}(${(node.nodes ?? []).map((n) => shape(n as never)).join(',')})`
  if (node.kind === 'name' || node.kind === 'text') return `${node.kind}:${(node.parts ?? []).map((p) => p.text ?? '{}').join('')}`
  return `lit:${node.token?.text ?? node.value}`
}
function shapeOf(text: string): string {
  const r = parse({ file: 's.tree', text })
  return r.ok ? shape(r.tree as never) : 'unparsed'
}

const SOURCE = `task find-fibonacci
  take n, like number
  fork test
    hook test
      call is-below
        loan n
        mark 2
    hook hold
      back n
    hook miss
      back
        call add
          loan n
          mark 1
`

function main(): void {
  const once = format({ file: 's.tree', text: SOURCE })
  const twice = format({ file: 's.tree', text: once })
  ok('idempotent: format(format(x)) === format(x)', once === twice, JSON.stringify(once))
  ok('meaning preserved: same structure after formatting', shapeOf(SOURCE) === shapeOf(once))

  // a short value list stays inline (round-trips and fits)
  ok('short value list stays inline', once.includes('take n, like number'), once)
  // a call with arguments stacks its arguments (would flatten ambiguously if inlined)
  ok('nested call arguments are stacked', /call add\n\s+loan n\n\s+mark 1/.test(once), once)

  // a stacked value list that could fit on one line is normalized to the inline form
  const stacked = `save\n  a\n  mark 0\n`
  const formatted = format({ file: 's.tree', text: stacked })
  ok('normalizes stacked value list to inline', formatted.trim() === 'save a, mark 0', JSON.stringify(formatted))

  // comments are preserved
  const commented = `task f\n  # a leading comment\n  back n\n`
  const out = format({ file: 's.tree', text: commented })
  ok('preserves comments', out.includes('# a leading comment'), JSON.stringify(out))

  console.log(`\nformat: ${pass} pass, ${fail} fail`)
}

main()
