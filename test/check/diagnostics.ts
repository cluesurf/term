// Phase 2 of note/term/gaps/plan.md: diagnostics that name the problem. Each block is a term.surf guide's own
// sample, held two ways: the message a reader could not act on is gone, and the one they can is there.
//
// Run: npx tsx test/check/diagnostics.ts

import { compile } from '@term/make/code/compile/compile'
import { showType } from '@term/make/code/compile/node'
import { renderKink } from '@term/make/code/parser/diagnostic'
import { describeOwed } from '@term/make/code/check/holds'
import type { Owed } from '@term/make/code/check/holds'
import { readable } from '@term/call/code/test-preprocess'
import { projectResolver } from '@term/call/code/make'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TERM = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

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

// every message the build gave, joined, or '' when it built
function said(text: string): string {
  const out = compile({ file: '/gate/code/main.tree', text }, {})

  return out.ok ? '' : out.diagnostics.map(d => d.message).join(' | ')
}

// ---- types, basics/tour, basics/first-program: Term's names, not the checker's ----
{
  const argument = said(`task greet
  take name, like text
  like text
  send back, text <hello>

task welcome
  like text
  send back
    call greet
      code 36
`)
  ok('a number passed for text says `expected text`', /expected text, found number/.test(argument), argument)
  ok('and never the TypeScript name', !/string/.test(argument), argument)

  const nothing = said(`task greet
  take name, like text
  like text
  send back, text <hello>

task welcome
  take n, like void
  like text
  send back
    call greet
      read n
`)
  ok('a void is `void`, not `unit`', /found void/.test(nothing) && !/unit/.test(nothing), nothing)
}

// ---- the printer itself, one line per shape a message can hold ----
{
  const text = { kind: 'string' } as const
  const number = { kind: 'number' } as const

  ok('a list of text', showType({ kind: 'array', element: text }) === 'list, like text')
  ok('a hash from text to numbers', showType({ kind: 'map', key: text, value: number }) === 'hash, like text, like number')
  ok('a list whose element is not solved is a bare list, not `?2[]`', showType({ kind: 'array', element: { kind: 'variable', id: 2 } }) === 'list')
  ok('a generic form with its argument', showType({ kind: 'named', name: 'chain', args: [number] }) === 'chain, like number')
  ok(
    'a task, its compound parameter wrapped so its commas stay its own',
    showType({ kind: 'function', params: [{ kind: 'array', element: text }, number], result: { kind: 'unit' } }) ===
      'task((list, like text), number) -> void',
    showType({ kind: 'function', params: [{ kind: 'array', element: text }, number], result: { kind: 'unit' } }),
  )
}

// ---- commands/roll: a site counts from one, and a signature is in Term's names ----
{
  const out = compile(
    {
      file: '/gate/code/store.tree',
      text: `form missing
  link thing, like text
  link limit, like number, need false

task find-user
  take key, like text
  like text
  send back, read key
`,
    },
    { roll: true },
  )
  const task = out.ok ? out.roll?.task.find(t => t.name === 'find-user') : undefined

  ok('a task\'s site is its line counted from one, as an error frame counts', task?.site.endsWith('store.tree:5:1') === true, task?.site)
  ok(
    'and its signature reads `text`',
    task !== undefined && JSON.stringify(task).includes('"like":"text"') && !JSON.stringify(task).includes('string'),
    JSON.stringify(task),
  )
}

// ---- commands/lint: a lint rule's code is printed as the rule is numbered ----
{
  const span = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 4, offset: 4 } }
  const base = { name: 'line-layout', message: 'x', file: 'a.tree', span, markers: [{ span }], severity: 'warning' as const }
  const lint = renderKink({ ...base, code: 23, rule: 'L023' }, ['task'], false)
  const compiler = renderKink({ ...base, code: 0x7, name: 'type-mismatch' }, ['task'], false)

  ok('L023 prints as `L023`, not `0017`', /code <L023>/.test(lint) && !/0017/.test(lint), lint)
  ok('and a compiler code still prints in its own hexadecimal', /code <0007>/.test(compiler), compiler)
}

// ---- commands/test: an error in a test file points at the line as written ----
{
  // the bad argument is on line 9 of what the person wrote (index 8), at column 9
  const source = `task greet
  take name, like text
  like text
  send back, read name

test greets
  want hold
    call is-equal
      call greet(36)
      text <hi>
`
  const unit = readable(source)
  // with the resolver `term test` compiles it with: a `want` that compares two values loads the exception it raises
  const out = compile({ file: '/gate/test/greet.tree', text: unit.text }, { resolve: projectResolver(TERM) })
  const first = out.ok ? undefined : out.diagnostics[0]
  const placed = first ? unit.place(first) : undefined

  ok('a test file with a type error does not build', first !== undefined, first?.message)
  ok('the compiler places it in the rewritten text, a line the person never wrote', first?.span.start.line !== 8, JSON.stringify(first?.span))
  ok(
    'and the error is placed on the line the person wrote',
    placed?.diagnostic.span.start.line === 8 && source.split('\n')[8]!.includes('greet(36)'),
    JSON.stringify(placed?.diagnostic.span),
  )
  ok('framed against the source, not the rewritten text', placed?.text === source)
}

// ---- language/data, commands/mold: a key given twice is reported where it is given the second time ----
{
  const out = compile(
    {
      file: '/gate/data/service.tree',
      text: `host service
  host retries, 3
  host region, <eu>
  host retries, 5
`,
    },
    {},
  )
  const twice = out.ok ? undefined : out.diagnostics.find(d => /"retries" is given twice/.test(d.message))

  ok('a key given twice is refused', twice !== undefined, out.ok ? 'built' : out.diagnostics.map(d => d.message).join(' | '))
  ok('at the second `retries`, line 4', twice?.span.start.line === 3, JSON.stringify(twice?.span))
  ok('with a note that says what to do, not the generic syntax note', /keep one of the two/.test(twice?.hint ?? ''), twice?.hint)
}

// ---- proofs/equality: a kernel error names variables and cases as the source does ----
{
  const out = compile(
    {
      file: '/gate/code/vec.tree',
      text: `form nat
  case zero
  case succ
    link prior, like nat

form vec
  head n, like nat
  case empty
    head make zero
  case push
    link count, like nat
    link item, like nat
    link rest, like vec
      head read count
    head make succ, bind prior, read count

task first
  take count, like nat
  take v, like vec, head make succ, bind prior, read count
  like nat
  sift v
    case push
      link item
      send back, read item

task use-first
  like nat
  send back
    call first
      make zero
      make empty
`,
    },
    {},
  )
  const said = out.ok ? 'built' : out.diagnostics.map(d => d.message).join(' | ')

  ok('a call with an empty vector is refused by the kernel', /kernel: type mismatch/.test(said), said)
  ok('naming the cases `succ` and `zero`, not `nat__succ`', /\(vec \(succ zero\)\)/.test(said) && !/__/.test(said), said)
}

// ---- proofs/equality: the convoy's wrong `refl` names `c` and `z`, which printed as `#1` and `#3` ----
{
  // the guide's `chain`, lean, with `make equal/refl, bind c, c` where it returns `r`
  const chain = `load @term/base/proof/equal
  find equal

task chain
  head a
  take x, like a
  take y, like a
  take z, like a
  take left
    like
      equal a
      head read x
      head read y

  like task
    take r
      like
        equal a
        head read y
        head read z
    like
      equal a
      head read x
      head read z

  sift left
    case refl
      link c
      back
        task id
          take r
            like
              equal a
              head read c
              head read z

          like
            equal a
            head read c
            head read z

          back make equal/refl, bind c, c
`
  const file = join(TERM, 'test/check/convoy.tree')
  const out = compile({ file, text: chain }, { resolve: projectResolver(TERM, 'node'), env: 'node', leanOf: () => true })
  const said = out.ok ? 'built' : out.diagnostics.map(d => d.message).join(' | ')

  ok('the convoy with `refl` for `r` is refused by the kernel', /kernel: type mismatch/.test(said), said)
  ok('naming the arm\'s variable and the parameter', /expected \(\(\(equal a\) c\) z\)/.test(said) && /found\s+\(\(\(equal a\) c\) c\)/.test(said), said)
  ok('and no de Bruijn index', !/#\d/.test(said), said)
}

// ---- tests/laws: a hold out of reach says it may be true, and says where `mark open` goes ----
{
  const out = compile(
    {
      file: '/gate/code/square.tree',
      text: `task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2

task use
  take n, like number
  like number
  hold
    call is-equal
      call double
        read n
      call add
        read n
        code 1
  send back, read n
`,
    },
    {},
  )
  const all = out.ok ? [...(out as { warnings?: { name: string; message: string; hint?: string }[] }).warnings ?? []] : out.diagnostics
  const hold = all.find(d => d.name === 'unchecked-hold')

  ok('a hold over a call to another task is reported as out of reach', hold !== undefined, JSON.stringify(all.map(d => d.name)))
  ok('saying it was neither proven nor refuted', /neither proven nor refuted/.test(hold?.message ?? ''), hold?.message)
  ok('and offering `mark open` only on a claim', /a `rule` with no `show`/.test(hold?.hint ?? ''), hold?.hint)
}

// ---- language/errors, library/exceptions: bounds and tells name the exception problem ----
{
  const linked = (file: string, text: string) =>
    compile({ file: join(TERM, 'test/check', file), text }, { resolve: projectResolver(TERM, 'node'), env: 'node' })
  const CHECK = `load @term/base/exception
  find absence
  find excess

task check-size
  take size, like number
  halt excess
  halt absence
  like number
  fork test
    hook test
      call is-above
        read size
        code 40
    hook hold
      halt excess
        bind thing, <size>
        bind limit, code 40
        bind actual, read size
  send back, read size
`
  const bound = linked('bound.tree', CHECK)
  const boundSaid = bound.ok ? 'built' : bound.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ')

  ok('a bound on a standard exception the body never raises is refused', !bound.ok, boundSaid)
  ok('saying nothing it calls raises it, not that it is no exception form', /nothing it calls raises "absence"/.test(boundSaid) && !/not an exception form/.test(boundSaid), boundSaid)
  ok('under a name about raise bounds', /raise-bound/.test(boundSaid), boundSaid)

  const alone = linked('tells.tree', 'tell @term/base/excess, note <Too large>\n')

  ok('a file of tells alone is not judged on what the app reaches', alone.ok, alone.ok ? '' : alone.diagnostics.map(d => d.message).join(' | '))

  const stale = linked('stale.tree', `${CHECK.replace('  halt absence\n', '')}
tell @term/base/overage, note <Too many requests>
`)
  const staleSaid = stale.ok ? 'built' : stale.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ')

  ok('a tell nothing raises is refused as `stale-tell`', /stale-tell: "@term\/base\/overage" is a standard exception, but nothing in this program raises it/.test(staleSaid), staleSaid)
}

// ---- language/notes: the build line names each obligation's kind ----
{
  const out = compile(
    {
      file: '/gate/code/serve.tree',
      text: `task serve
  like void
  save turns, code 0
  walk test
    hook test, true
    hook hold
      save turns
        call add
          read turns
          code 1
`,
    },
    {},
  )
  const owed = out.ok ? (out as { obligations?: Owed }).obligations : undefined

  ok('a walk that may not end owes a termination proof, counted as one', owed?.kinds?.ends?.total === 1, JSON.stringify(owed))
  ok('and the build line names it, not list reads and division', owed !== undefined && describeOwed(owed) === '0 of 1 walks shown to end', owed && describeOwed(owed))
}

// ---- language/tasks: a required argument left out is reported once ----
{
  const once = said(`task area
  take w, like number
  take h, like number
  like number
  send back
    call multiply
      read w
      read h

task use
  like number
  send back
    call area
      code 3
`)
  const lines = once.split(' | ')

  ok('a left-out argument is refused, naming it', /"area" needs "h", which this call leaves out/.test(once), once)
  ok('and only once, not again as a mismatch with `void`', lines.length === 1 && !/void/.test(once), once)
}

// ---- commands/view: a refused document says what a document allows, not where the brackets go ----
{
  const out = compile(
    {
      file: '/gate/page/hostile.tree',
      text: `view text/heading
  <Sounds>

task steal
  like text
  send back, text <x>
`,
    },
    { roleOf: () => 'view' },
  )
  const refused = out.ok ? undefined : out.diagnostics.find(d => /"task" is not part of a document/.test(d.message))

  ok('a task in a document is refused', refused !== undefined, out.ok ? 'built' : out.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
  ok('as `document-refused`, with advice about documents', refused?.name === 'document-refused' && !/brackets/.test(refused.hint ?? ''), `${refused?.name} ${refused?.hint}`)
}

// ---- language/templates: an error in an expansion points at the fuse that caused it ----
{
  const out = compile(
    {
      file: '/gate/code/tags.tree',
      text: `tree is-tag
  take name
  take tag
  hook fuse
    task is-{name}
      take value, like number

      like boolean

      back is-equal(value, code {tag})

fuse is-tag
  bind name, red
  bind tag, 0

fuse is-tag
  bind name, green
`,
    },
    { leanOf: () => true },
  )
  const lines = out.ok ? [] : out.diagnostics.map(d => d.span.start.line)

  ok('a fuse that leaves out a hole fails the build', !out.ok, out.ok ? 'built' : '')
  ok(
    'and every error is in that fuse, lines 15 and 16, not at the `tree` on line 1',
    lines.length > 0 && lines.every(line => line === 14 || line === 15),
    out.ok ? '' : out.diagnostics.map(d => `${d.span.start.line + 1}: ${d.message}`).join(' | '),
  )
}

// ---- language/syntax: the one line the grammar could not read is named, in a longhand file too ----
{
  const typo = said(`task more
  take n, like number
  like number
  save total, read n
  fork test, is-above n, 0
    hodl
      send back, read total
  send back, read n
`)

  ok('an unreadable `fork` names the `fork` line', /`fork` is a statement, and its grammar could not read this line/.test(typo), typo)
  ok('and nothing else: not `test`, `hodl` or `back` as undefined names', typo.split(' | ').length === 1, typo)

  const comma = said(`task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2

task more
  take n, like number
  like number
  send back
    call add
      call double
        read n
        code 1
`)

  ok('an argument too many names the call it landed in', /"double" takes 1 argument, and this is one more/.test(comma), comma)
}

// ---- a warning names the file it is about ----
{
  const helper = `task helper
  take n, like number
  like number
  save spare, code 1
  send back, read n
`
  const out = compile(
    {
      file: '/gate/code/main.tree',
      text: `load ./helper
  find helper

task main
  like number
  save extra, code 2
  send back
    call helper
      code 3
`,
    },
    { resolve: path => (path === './helper' ? { file: '/gate/code/helper.tree', text: helper } : undefined) },
  )
  const warnings = (out as { warnings?: { message: string; span?: { file?: string } }[] }).warnings ?? []
  const named = warnings.map(w => w.message).join(' | ')

  ok('the entry file\'s own unused binding is reported', /"extra" is never used/.test(named), named)
  ok('and a loaded module\'s is not stamped with the entry file\'s name', !/"spare"/.test(named), named)
  ok(
    'every warning names the file its span is in',
    warnings.every(w => w.span?.file === undefined || (w as { file?: string }).file === w.span.file),
    JSON.stringify(warnings.map(w => [(w as { file?: string }).file, w.span?.file])),
  )
}

console.log(`\ndiagnostics: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
