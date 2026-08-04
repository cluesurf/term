// Formatter tests: canonical layout, idempotence, comment preservation, and (above all) meaning preservation.
// Run: npx tsx test/format/run.ts

import { format } from '@term/make/code/format/format'
import { parse } from '@term/make/code/parser/tree'

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
function shape(node: {
  kind: string
  nodes?: unknown[]
  parts?: { kind: string; text?: string }[]
  value?: unknown
  token?: { text: string }
}): string {
  if (node.kind === 'group' || node.kind === 'root')
    {return `${node.kind}(${(node.nodes ?? [])
      .map(n => shape(n as never))
      .join(',')})`}

  if (node.kind === 'name' || node.kind === 'text')
    {return `${node.kind}:${(node.parts ?? [])
      .map(p => p.text ?? '{}')
      .join('')}`}

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
        code 2
    hook hold
      send back n
    hook miss
      send back
        call add
          loan n
          code 1
`

function main(): void {
  const once = format({ file: 's.tree', text: SOURCE })
  const twice = format({ file: 's.tree', text: once })
  ok(
    'idempotent: format(format(x)) === format(x)',
    once === twice,
    JSON.stringify(once),
  )
  ok(
    'meaning preserved: same structure after formatting',
    shapeOf(SOURCE) === shapeOf(once),
  )

  // a short value list stays inline (round-trips and fits)
  ok(
    'short value list stays inline',
    once.includes('take n, like number'),
    once,
  )
  // a call with arguments stacks its arguments (would flatten ambiguously if inlined)
  ok(
    'nested call arguments are stacked',
    /call add\n\s+loan n\n\s+code 1/.test(once),
    once,
  )

  // a stacked value list that could fit on one line is normalized to the inline form
  const stacked = `save\n  a\n  code 0\n`
  const formatted = format({ file: 's.tree', text: stacked })
  ok(
    'normalizes stacked value list to inline',
    formatted.trim() === 'save a, code 0',
    JSON.stringify(formatted),
  )

  // comments are preserved
  const commented = `task f\n  # a leading comment\n  back n\n`
  const out = format({ file: 's.tree', text: commented })
  ok(
    'preserves comments',
    out.includes('# a leading comment'),
    JSON.stringify(out),
  )

  // blank-line grouping in a task body: signature heads grouped (take | like), signature set off from the body, and a
  // block (walk) set off from the preceding simple statement -- but a statement after a block (send) stays tight.
  {
    const spaced = format({
      file: 'b.tree',
      text: `task work\n  take xs\n  like number\n  save n, code 0\n  walk list\n    read xs\n    hook next\n      take site, name item\n      save n, code 1\n  send back, read n\n`,
    })

    const lines = spaced.split('\n')

    const blankBefore = (needle: string): boolean => {
      const i = lines.findIndex(l => l.trim().startsWith(needle))

      return i > 0 && lines[i - 1] === ''
    }

    ok(
      'blank before the result type (signature head change)',
      blankBefore('like number'),
      JSON.stringify(lines),
    )
    ok(
      'blank before the first statement (signature -> body)',
      blankBefore('save n, code 0'),
      JSON.stringify(lines),
    )
    ok(
      'blank before a block after a simple statement (walk)',
      blankBefore('walk list'),
      JSON.stringify(lines),
    )
    ok(
      'no blank before a statement that follows a block (send)',
      !blankBefore('send back'),
      JSON.stringify(lines),
    )
    ok(
      'task-body spacing is idempotent',
      format({ file: 'b.tree', text: spaced }) === spaced,
    )
  }

  // a task / form definition always stacks (head on its own line), never collapsed onto one line
  {
    const t = format({
      file: 'd.tree',
      text: `task one\n  send back, code 1\n`,
    })

    ok(
      'a single-statement task stays stacked',
      t.split('\n')[0] === 'task one' &&
        t.includes('\n  send back, code 1'),
      JSON.stringify(t),
    )
  }

  // a comment longer than 80 chars is word-wrapped; a short comment is left untouched
  {
    const long =
      '# this is a very long leading comment that definitely goes well beyond the eighty character limit and keeps going'

    const wrapped = format({
      file: 'c.tree',
      text: `${long}\ntask f\n  # lint off L003\n  send back, code 1\n`,
    })

    ok(
      'a long comment wraps to <= 84 chars',
      wrapped.split('\n').every(l => l.length <= 84),
      JSON.stringify(wrapped.split('\n').filter(l => l.length > 84)),
    )
    ok(
      'a short directive comment is left intact',
      wrapped.includes('# lint off L003'),
      wrapped,
    )
  }

  console.log(`\nformat: ${pass} pass, ${fail} fail`)
}

main()
