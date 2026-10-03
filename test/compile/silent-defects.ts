// Eight programs that compiled with NO message and emitted WRONG code, found writing the guides lean on 2026-10-02
// (note/term/guides/readme.md, "Code samples are lean"). Each is held here two ways: the output it must emit now, and
// the wrong output it emitted before, which must be gone. Where the answer is a refusal, the message is held.
//
//   1. a bare call over `bind` lines dropped the names and passed the values in written order
//   2. a bare `term` / `text` / `code` was the empty literal even with a parameter of that name in scope
//   3. a bare path with a braced segment, `back names/{at}`, emitted `return names.`
//   4. a bare `hold` under `walk test` was dropped, and the loop ran with no body
//   5. `wait f(x)` as a statement in a task body vanished
//   6. `host(route, port)`, a call to a task named `host`, was read as the constant keyword
//   7. a bare call under a view's `seed click` bound an attribute instead of attaching a handler
//   8. a grammar's `mine char, <.>` lost its character check
//
// Run: npx tsx test/compile/silent-defects.ts

import { compile } from '@term/make/code/compile/compile'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import {
  compileFeedMine,
  feedMineFaults,
  readFeedMineGrammar,
} from '@term/make/code/compile/feed-mill'

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

// the emitted TypeScript, or the diagnostics as one string when it did not build
function emit(text: string, lean = false): string {
  const out = compile(
    { file: '/gate/code/silent.tree', text },
    { leanOf: () => lean },
  )

  return out.ok
    ? out.typescript
    : `DIAGNOSTICS: ${out.diagnostics.map(d => d.message).join(' | ')}`
}

// the one exported function's body, from `export function <name>(` to its closing brace
function body(ts: string, name: string): string {
  const start = ts.indexOf(`export function ${name}(`)
  const async = ts.indexOf(`export async function ${name}(`)
  const at = start >= 0 ? start : async

  if (at < 0) {
    return `(no function ${name})`
  }

  const end = ts.indexOf('\n}\n', at)

  return ts.slice(at, end < 0 ? undefined : end + 2)
}

// ---- 1. a bare call over `bind` lines keeps the names ----

{
  const gap = `
task gap
  take width, like number
  take height, like number
  like number
  send back
    call subtract
      read width
      read height
`
  const bare = emit(`${gap}
task use-gap
  like number
  send back
    gap
      bind height, code 3
      bind width, code 4
`)
  const long = emit(`${gap}
task use-gap
  like number
  send back
    call gap
      bind height, code 3
      bind width, code 4
`)

  ok('1. a bare call over bind lines emits what `call` emits', bare === long, bare)
  ok('1. ...and passes width 4, height 3 (returns 1)', /return 1\b/.test(body(bare, 'useGap')), body(bare, 'useGap'))
  ok('1. ...and not the values in written order (returns -1)', !/return -1\b/.test(bare), body(bare, 'useGap'))

  const unknown = emit(`${gap}
task use-gap
  like number
  send back
    gap
      bind depth, code 3
      bind width, code 4
`)

  ok('1. a bind naming no parameter is refused, as under `call`', unknown.startsWith('DIAGNOSTICS') && /depth/.test(unknown), unknown)
}

// ---- 2. a bare value word is the local of that name ----

for (const [word, type, literal] of [
  ['term', 'text', '""'],
  ['text', 'text', '""'],
  ['code', 'number', '0'],
] as const) {
  const ts = emit(`
task echo
  take ${word}, like ${type}
  like ${type}
  send back
    ${word}
`)

  ok(`2. a bare \`${word}\` with a parameter \`${word}\` returns the parameter`, new RegExp(`return ${word}\\b`).test(body(ts, 'echo')), body(ts, 'echo'))
  ok(`2. ...and not the literal ${literal}`, !body(ts, 'echo').includes(`return ${literal}`), body(ts, 'echo'))
}

{
  const local = emit(`
task echo
  like text
  save term, text <hi>
  send back
    term
`)

  // the optimizer folds the local into the return, so the value is what shows
  ok('2. a bare `term` with a local `term` returns the local', /return (term|"hi")$/m.test(body(local, 'echo')), body(local, 'echo'))

  const item = emit(`
task first
  take words, like list, like text
  like text
  save found, text <>
  walk list, read words
    hook next
      take site, name text
      save found, text
  send back, read found
`)

  ok('2. a bare `text` naming a walk item reads the item', /found = text\b/.test(body(item, 'first')), body(item, 'first'))

  const none = emit(`
task echo
  like text
  send back
    term
`)

  ok(
    '2. a bare `term` with no local of that name is refused, naming `read term`',
    none.startsWith('DIAGNOSTICS') && none.includes('a bare `term` is not a value') && none.includes('`read term`'),
    none,
  )
}

// ---- 3. a path with a braced segment ----

{
  const lean = emit(`
task pick
  take names, like list, like text
  take at, like number
  like text
  back names/{at}
`)
  const long = emit(`
task pick
  take names, like list, like text
  take at, like number
  like text
  send back, read names/{at}
`)

  ok('3. `back names/{at}` emits what `read names/{at}` emits', lean === long, body(lean, 'pick'))
  ok('3. ...a bounds-checked read', body(lean, 'pick').includes('names[at]'), body(lean, 'pick'))
  ok('3. ...and not `return names.`', !/return names\.\s*$/m.test(lean), body(lean, 'pick'))
}

// ---- 4. a bare `hold` under `walk test` is the body ----

{
  const count = (arm: string): string =>
    emit(`
task count-up
  take n, like number
  like number
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    ${arm}
      save i
        call add
          read i
          code 1
  send back, read i
`)
  const bare = count('hold')
  const hooked = count('hook hold')

  ok('4. a bare `hold` under `walk test` emits what `hook hold` emits', bare === hooked, body(bare, 'countUp'))
  ok('4. ...with the body in the loop', /while \(i < n\) \{\s*i = i \+ 1/.test(body(bare, 'countUp')), body(bare, 'countUp'))
  ok('4. ...and not an empty loop', !/while \([^)]*\) \{\}/.test(bare), body(bare, 'countUp'))

  const stray = emit(`
task spin
  take n, like number
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    save i
      call add
        read i
        code 1
`)

  ok(
    '4. a statement directly under `walk test` is refused, naming `hold`',
    stray.startsWith('DIAGNOSTICS') && stray.includes('directly under a `walk test`') && stray.includes('under `hold`'),
    stray,
  )

  const two = emit(`
task spin
  take n, like number
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      save i, code 1
    hold
      save i, code 2
`)

  ok('4. a `hook hold` and a bare `hold` together are two bodies, refused', two.includes('has two bodies'), two)
}

// ---- 5. `wait f(x)` as a statement ----

{
  const prelude = `
task append
  note async
  take target, like text
  take line, like text
  like text
  send back, read line
`
  const lean = emit(`${prelude}
task log
  note async
  take target, like text
  take line, like text
  like text
  save x, read line
  wait append(target, text <{{line}}!>)
  send back, read x
`)
  const long = emit(`${prelude}
task log
  note async
  take target, like text
  take line, like text
  like text
  save x, read line
  call append
    read target
    text <{{line}}!>
    wait true
  send back, read x
`)

  ok('5. `wait f(x)` as a statement emits what `call f / wait true` emits', lean === long, body(lean, 'log'))
  ok('5. ...the awaited call, before the return', /await append\(target, `\$\{line\}!`\)\n\s*return /.test(body(lean, 'log')), body(lean, 'log'))

  const closure = emit(`${prelude}
task run
  note async
  take target, like text
  save go
    task
      note async
      wait append(target, text <a>)
      wait append(target, text <b>)
  wait go()
`)

  ok('5. ...and in a closure body, both lines, in order', /await append\(target, "a"\)\s*\n\s*await append\(target, "b"\)/.test(closure), closure)

  const marker = emit(`${prelude}
task log
  note async
  take target, like text
  call append
    read target
    text <a>
    wait append(target, text <b>)
`)

  ok('5. a `wait <call>` under a call is refused, not dropped', marker.includes('a `wait` under a call marks the call itself'), marker)
}

// ---- 6. a task named `host` ----

{
  // `host` pushes onto a list, so the optimizer cannot fold the call away and the call is what shows
  const host = `
task host
  take routes, like list, like text
  take route, like text
  call routes/push
    read route
`
  const paren = emit(`${host}
task boot
  take routes, like list, like text
  take url, like text
  host(routes, url)
`)
  const long = emit(`${host}
task boot
  take routes, like list, like text
  take url, like text
  call host(routes, url)
`)

  ok('6. `host(routes, url)` as a statement emits what `call host` emits', paren === long, body(paren, 'boot'))
  ok('6. ...the call', /host\(routes, url\)|routes\.push\(url\)/.test(body(paren, 'boot')), body(paren, 'boot'))
  ok('6. ...and the body is not empty', !/export function boot\([^)]*\): [a-z]+ \{\}/.test(paren), body(paren, 'boot'))

  const stacked = emit(`${host}
task boot
  take routes, like list, like text
  take url, like text
  host
    url
    routes
`)

  ok(
    '6. a stacked `host` over a parameter is refused, naming `host(url, ...)` and `call host`',
    stacked.includes('`host url` declares a constant named `url`, and `url` is already bound here') && stacked.includes('`call host`'),
    stacked,
  )

  const constant = emit(`${host}
task boot
  take url, like text
  host limit, code 10
`)

  ok(
    '6. a constant in a body, in a file with a task named `host`, is refused as two readings',
    constant.includes('this file has a task named `host`, so `host limit` reads both as a constant and as a call'),
    constant,
  )

  const plain = emit(`
task area
  like number
  host side, code 10
  send back
    call multiply
      read side
      read side
`)

  // folded by the optimizer to the product, which is the constant having been read
  ok('6. a `host` constant in a body still builds where no task is named `host`', /return 100\b/.test(body(plain, 'area')), plain)
}

// ---- 7. a bare call under a view's `seed click` is an event handler ----

{
  const source = `
task submit-email
  take a, like text
  take b, like text

view stacked
  view button
    seed click
      submit-email
        text <x>
        text <y>
    text <Subscribe>

view inline
  view button
    seed click
      submit-email(text <x>, text <y>)
    text <Subscribe>

view called
  view button
    seed click
      call submit-email
        text <x>
        text <y>
    text <Subscribe>

view value
  view button
    seed title
      text <Subscribe>
`
  const parsed = parse({ file: '/gate/code/view.tree', text: source })
  const milled = parsed.ok ? mill(parsed.tree, '/gate/code/view.tree') : undefined
  const views = milled?.ok
    ? milled.program.filter((s): s is Extract<typeof s, { form: 'view' }> => s.form === 'view')
    : []
  const eventOf = (name: string, attribute: string): boolean | undefined => {
    const view = views.find(v => v.name === name)
    const element = view?.body[0]

    return element?.form === 'element'
      ? element.attributes.find(a => a.name === attribute)?.event
      : undefined
  }

  ok('7. `call submit-email` under `seed click` is a handler', eventOf('called', 'click') === true)
  ok('7. a stacked bare `submit-email` is a handler too', eventOf('stacked', 'click') === true, String(eventOf('stacked', 'click')))
  ok('7. `submit-email(x, y)` is a handler too', eventOf('inline', 'click') === true, String(eventOf('inline', 'click')))
  ok('7. a literal attribute is still not a handler', eventOf('value', 'title') === false, String(eventOf('value', 'title')))

  const ts = emit(source)

  ok('7. the bare call emits `attachEvent`, as `call` does', (ts.match(/attachEvent\(/g) ?? []).length === 3, ts.slice(0, 600))
  ok('7. ...and binds no click attribute', !/bindAttribute\([^,]+, "click"/.test(ts), ts.slice(0, 600))
}

// ---- 8. a grammar's `mine char, <.>` keeps its check ----

{
  const grammar = (char: string): string => `
mine version
  mine form, form digits
    send major
  ${char}
  mine form, form digits
    send minor

mine digits
  mine list
    mine range
      bind base, <0>
      bind head, <9>
`
  const reader = (char: string): string => {
    const parsed = parse({ file: '/gate/code/mine.tree', text: grammar(char) })

    return parsed.ok
      ? compileFeedMine(readFeedMineGrammar(parsed.tree), 'text', '@term/feed/code/base')
      : 'PARSE FAILED'
  }

  const long = reader('mine char, text <.>')

  for (const spelling of ['mine char, <.>', 'mine char, code 46', 'mine char, 46']) {
    const short = reader(spelling)

    ok(`8. \`${spelling}\` generates the reader \`mine char, text <.>\` does`, short === long)
    ok(`8. ...which checks for character 46`, short.includes('expected character 46'), short.slice(0, 400))
  }

  const faults = (char: string): string[] => {
    const parsed = parse({ file: '/gate/code/mine.tree', text: grammar(char) })

    return parsed.ok ? feedMineFaults(parsed.tree) : ['PARSE FAILED']
  }

  ok('8. a char with its literal has no fault', faults('mine char, <.>').length === 0, faults('mine char, <.>').join(' | '))

  const empty = faults('mine char')

  ok(
    '8. a `mine char` naming no character is a fault, with the line and the spelling to write',
    empty.length === 1 && empty[0]!.includes('at line 5') && empty[0]!.includes('`mine char, <.>`'),
    empty.join(' | '),
  )
}

console.log(`\n${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
