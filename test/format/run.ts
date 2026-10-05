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
  // a call with arguments inlines them when they fit. A part that a COMMA FOLLOWS is parenthesized, because a
  // comma pops exactly one level: `call add, loan n, code 1` would read `code 1` as a child of `loan`, leaving
  // `add` one argument. `loan(n)` closes its own group, so the comma lands where it belongs. The last part needs
  // nothing after it, so `code 1` stays bare.
  ok(
    'call arguments inline when they fit',
    once.includes('call add, loan(n), code 1'),
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

  // ---- an interpolation's brace depth survives, in a TEXT literal too ----
  //
  // `{x}` is compile-time substitution (and the view dialect's field interpolation); `{{x}}` is runtime
  // interpolation. The NAME case was fixed to re-emit each part at its own depth after `{platform}` import paths
  // doubled; the TEXT case still hardcoded two braces, so canonicalizing a guide turned `text <{sound/symbol}>`
  // into `text <{{sound/symbol}}>` — a different construct, silently. Found by the word.surf guide round-trip
  // test, which requires format(x) to parse and mean the same thing.
  {
    const doc = 'view page\n  view text\n    text <{sound/symbol}>\n'
    const formatted = format({ file: 'doc.tree', text: doc })

    ok(
      'a single-brace text interpolation stays single-brace',
      formatted.includes('<{sound/symbol}>'),
      formatted,
    )

    // and a genuine runtime interpolation stays double
    const runtime = 'task t\n  take x, like text\n  like text\n  send back, text <a {{x}} b>\n'
    const runtimeOut = format({ file: 'r.tree', text: runtime })

    ok(
      'a double-brace runtime interpolation stays double-brace',
      runtimeOut.includes('{{x}}'),
      runtimeOut,
    )
  }

  rules()

  console.log(`\nformat: ${pass} pass, ${fail} fail`)
}

// ---- "Where each part of a line goes", note/term/format-rules.md: the five rules, from its before and after ----
//
// The two columns of the page's example, exactly. The formatter also applies "Blank lines" (a blank after a task's
// signature, between signature heads, and before a block that follows a simple statement), which the page's right
// column leaves out to show where the parts go, so the comparison drops blank lines and nothing else.

const BEFORE = `load @term/base/list
  find list

task list-demo
  like number
  save items
    make list
      3
      1
  push
    items
    2
  save doubled
    map
      items
      task twice
        take n, like number
        like number
        back multiply(n, 2)
  back sum(doubled)
`

const AFTER = `load @term/base/list
  find list

task list-demo
  like number
  save items, make list, 3, 1
  push items, 2
  save doubled
    map items
      task twice
        take n, like number
        like number
        back multiply(n, 2)
  back sum(doubled)
`

function rules(): void {
  const dense = (text: string) => text.split('\n').filter(line => line.trim() !== '').join('\n')
  const out = format({ file: 'list-demo.tree', text: BEFORE })
  const lines = out.split('\n')
  const has = (line: string) => lines.includes(line)

  ok('the before column formats to the after column, blank lines aside', dense(out) === dense(AFTER), `\n${out}`)
  ok('the after column is already formatted, blank lines aside', dense(format({ file: 'a.tree', text: AFTER })) === dense(AFTER))
  ok('the before and after columns are one tree', shapeOf(BEFORE) === shapeOf(AFTER))

  // 1. a statement is one line
  ok('1. `push` over `items` and `2` is `push items, 2`', has('  push items, 2'), out)

  // 2. Term's own words chain with commas
  ok('2. `save items` over `make list` over `3` and `1` is `save items, make list, 3, 1`', has('  save items, make list, 3, 1'), out)
  {
    const typed = format({ file: 't.tree', text: 'task f\n  take xs\n    like list\n      like number\n  like list\n    like number\n  back xs\n' })

    ok('2. `like list` over `like number` is `like list, like number`', typed.includes('\n  like list, like number\n'), typed)
    ok('2. ...and under a `take`, `take xs, like list, like number`', typed.includes('\n  take xs, like list, like number\n'), typed)
  }

  {
    // a word closed in parentheses mid-line would read as a call (`bind(x, 1)`), so the group stacks instead
    const record = format({ file: 'r.tree', text: 'task f\n  insert\n    seen\n    make point\n      bind x, 1\n      bind y, 2\n' })

    ok('2. a record stacks rather than write `bind(x, 1)`', record.includes('  insert seen\n    make point\n      bind x, 1\n      bind y, 2\n'), record)
    ok('2. ...while `call add, read(a), read(b)` keeps its one-part words', format({ file: 'a.tree', text: 'task f\n  call add\n    read a\n    read b\n' }).includes('  call add, read(a), read b\n'))
  }

  // 3. a call reads by where it stands
  ok('3. a call after `back` takes parentheses: `back multiply(n, 2)`', has('        back multiply(n, 2)'), out)
  ok('3. ...and `back sum(doubled)`', has('  back sum(doubled)'), out)
  {
    const placed = format({
      file: 'p.tree',
      text: [
        'task f',
        '  take cursor, like text',
        '  take n, like number',
        '  push',
        '    result',
        '    read-number',
        '      cursor',
        '  want hold',
        '    is-equal',
        '      get(found, 1)',
        '      14',
        '  fork test',
        '    is-above',
        '      n',
        '      0',
        '    hold',
        '      back 1',
        '  back 0',
        '',
      ].join('\n'),
    })
    const lines = placed.split('\n')

    ok('3. an argument that is a call takes parentheses: `push result, read-number(cursor)`', lines.includes('  push result, read-number(cursor)'), placed)
    ok('3. a CONDITION reads with commas: `want hold, is-equal get(found, 1), 14`', lines.includes('  want hold, is-equal get(found, 1), 14'), placed)
    ok('3. ...never `is-equal(get(found, 1), 14)`', !placed.includes('is-equal('), placed)
    ok('3. a condition on its fork: `fork test, is-above n, 0`', lines.includes('  fork test, is-above n, 0'), placed)
    ok('3. the layout parses to the stacked tree', shapeOf(placed) === shapeOf(placed.replace('push result, read-number(cursor)', 'push\n    result\n    read-number\n      cursor')))
  }

  // 4. a block stacks, from the block on
  ok('4. `map items` keeps `items` on its line and stacks the `task`', /\n {4}map items\n {6}task twice\n/.test(out), out)
  ok('4. `save doubled` keeps `doubled` on its line and stacks the `map`', /\n {2}save doubled\n {4}map items\n/.test(out), out)
  {
    const loop = format({ file: 'w.tree', text: 'task f\n  take xs, like list\n  walk list\n    read xs\n    hook next\n      take site, name x\n      log x\n' })

    ok('4. a longhand loop keeps its list on the head line: `walk list, read xs`', loop.includes('\n  walk list, read xs\n    hook next\n'), loop)
  }

  // 5. too wide, or a comment inside, stacks
  {
    const wide = format({
      file: 'w.tree',
      text: 'task f\n  back add-all(first-long-argument-name, second-long-argument-name, third-long-argument-name)\n',
    })

    // one part per line, under rule 4's head line, which keeps the one leading word
    ok(
      '5. past 84 columns the group stacks',
      wide.split('\n').every(line => line.length <= 84) &&
        wide.includes('\n  back\n    add-all first-long-argument-name\n      second-long-argument-name\n'),
      wide,
    )

    const commented = format({ file: 'c.tree', text: 'task f\n  push\n    items\n    # the second\n    2\n' })

    ok('5. a comment inside stacks the group, and survives', commented.includes('  push items\n    # the second\n    2\n'), commented)
  }

  // the meaning check: the parser keeps no node for parentheses, so these two are one tree with two programs, and
  // the formatter must re-emit what the tokens said
  {
    const empty = format({ file: 'e.tree', text: 'task f\n  answer()\n  save b, make-box()\n  back b\n' }, { lean: true })

    ok('a call with no arguments keeps its parentheses: `answer()`', empty.includes('\n  answer()\n'), empty)
    ok('...and in a value position: `save b, make-box()`', empty.includes('\n  save b, make-box()\n'), empty)

    const host = format({ file: 'h.tree', text: 'task f\n  take route, like text\n  take port, like number\n  host(route, port)\n' })

    ok('`host(route, port)` stays a call, not the constant `host route, port`', host.includes('\n  host(route, port)\n'), host)
  }

  // in a LEAN file a bare head under a call may be a label, which only the checker can tell from a call, so a
  // call-shaped part keeps its written parentheses and a part written on its own line stays there
  {
    const labels = 'task use-gap\n  like number\n  back gap height(3), width 4\n\ntask origin\n  like point\n  back point x(0), y 0\n'
    const leanOut = format({ file: 'l.tree', text: labels }, { lean: true })

    ok('3. lean: a label keeps its spelling, `back gap height(3), width 4`', leanOut.includes('\n  back gap height(3), width 4\n'), leanOut)
    ok('3. lean: ...and `back point x(0), y 0`', leanOut.includes('\n  back point x(0), y 0\n'), leanOut)

    const stacked = format({ file: 's.tree', text: 'task f\n  back\n    gap\n      height 3\n      width 4\n' }, { lean: true })

    ok('3. lean: labels written one per line stay one per line', stacked.includes('  back\n    gap\n      height 3\n      width 4\n'), stacked)

    const outside = format({ file: 'o.tree', text: 'task f\n  back\n    gap\n      height 3\n      width 4\n' })

    ok('3. outside lean the same lines are calls, and take their parentheses', outside.includes('  back gap(height(3), width(4))\n'), outside)
  }

  // rule 3's parentheses are a call's: a dialect gets none
  {
    const grammar = format({ file: 'm.tree', text: 'mine flow\n  back\n    seed head\n      text\n' }, { role: 'mill' })

    ok('3. a `mill` file gets no call parentheses', !grammar.includes('('), grammar)
  }

  // a statement in a `test` block is a statement, not a value
  {
    const test = format({ file: 't.tree', text: 'test <split>\n  save parts, split(<a,,b>, <,>)\n  log <parts: {size(parts)}>\n' })

    ok('3. a statement in a `test` reads with commas, `log <parts: {size(parts)}>`', test.includes('\n  log <parts: {size(parts)}>\n'), test)
  }

  // a grammar file is known by its `mine` heads, with no role to say so
  {
    const grammar = format({ file: 'g.tree', text: 'mine version\n  mine form, form digits\n    send major\n  mine char, <.>\n' })

    ok('a grammar is returned as written', grammar === 'mine version\n  mine form, form digits\n    send major\n  mine char, <.>\n', grammar)
  }

  // a lean line one character too wide in the parentheses it was written with: the stack drops them anyway, so the
  // bare line is the first run's answer too, or the second run joins what the first broke
  {
    const wide = 'task t\n  want hold, is-equal(shown(run(call-program(<join>, make list(letters, str(<->))))), <a-b-c>)\n'
    const once = format({ file: 'w.tree', text: wide }, { lean: true })

    ok('lean: a line too wide in its parentheses is written bare when that fits', once.includes('\n    is-equal shown(run(call-program(<join>, make list(letters, str(<->))))), <a-b-c>\n'), once)
    ok('lean: ...and formatting it again changes nothing', format({ file: 'w.tree', text: once }, { lean: true }) === once)
  }

  // a path after a call is written back as it was, never as the braces the parser holds it in
  {
    const path = format({ file: 'p.tree', text: 'task t\n  log greeting()/text\n  log greet(<ada>)/text\n  log <{greet(who)/count} left>\n' }, { lean: true })

    ok('a path after a call keeps its spelling, `greeting()/text`', path.includes('  log greeting()/text\n  log greet(<ada>)/text\n  log <{greet(who)/count} left>\n'), path)
  }

  // every rule's output is idempotent
  for (const [label, text] of [
    ['the after column', AFTER],
    ['the before column', BEFORE],
  ] as const) {
    const once = format({ file: 'i.tree', text })

    ok(`idempotent on ${label}`, format({ file: 'i.tree', text: once }) === once)
  }
}

main()
