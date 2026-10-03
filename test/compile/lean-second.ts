// The second pass over the lean surface (note/term/plan/lean-surface-second-pass.md). Each section is held by what
// the compiler EMITS, never by what the parser builds alone:
//
//   1. `sift x` is `fork case, x`: the same TypeScript, Rust, Swift and Kotlin, in a longhand file and a lean one
//
// Run: npx tsx test/compile/lean-second.ts

import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import { format } from '@term/make/code/format/format'
import { analyze } from '@term/make/code/analyze'
import { applyFixes } from '@term/make/code/lint/lint'
import { parse, printTree } from '@term/make/code/parser/tree'
import { programOf } from '@term/make/code/format/meaning'

// the tree a source parses to, printed canonically, for "these two spellings are one tree"
function shape(text: string): string {
  const parsed = parse({ file: 's.tree', text })

  return parsed.ok ? printTree(parsed.tree) : 'PARSE FAILED'
}

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

type Built = { ok: true; ts: string; rs: string; swift: string; kotlin: string } | { ok: false; why: string }

// every backend's output for one source, or the diagnostics when it does not build
function build(text: string, lean = false): Built {
  const file = '/gate/code/second.tree'
  const out = compile({ file, text }, { leanOf: () => lean })

  if (!out.ok) {
    return { ok: false, why: out.diagnostics.map(d => d.message).join(' | ') }
  }

  const native = (env: 'rust' | 'swift' | 'kotlin') => {
    const result = compile({ file, text }, { leanOf: () => lean, env })

    return result.ok ? result.program : []
  }

  return {
    ok: true,
    ts: out.typescript,
    rs: emitRust(native('rust')),
    swift: emitSwift(native('swift')),
    kotlin: emitKotlin(native('kotlin')),
  }
}

function same(name: string, a: Built, b: Built): void {
  if (!a.ok || !b.ok) {
    ok(name, false, `${a.ok ? '' : a.why} ${b.ok ? '' : b.why}`)
    return
  }

  // an empty native program on both sides would compare equal and prove nothing
  ok(`${name}: every native backend built`, /\bfn \w/.test(a.rs) && /\bfunc \w/.test(a.swift) && /\bfun \w/.test(a.kotlin))
  ok(`${name}: TypeScript`, a.ts === b.ts, `\n${a.ts}\n---\n${b.ts}`)
  ok(`${name}: Rust`, a.rs === b.rs)
  ok(`${name}: Swift`, a.swift === b.swift)
  ok(`${name}: Kotlin`, a.kotlin === b.kotlin)
}

// ---- 1. `sift x` is `fork case, x` ----

{
  const shape = `
form shape
  case circle
    link radius, like number
  case square
    link side, like number
`
  const fork = build(`${shape}
task area
  take s, like shape
  like number
  fork case, read s
    case circle
      send back
        call multiply
          code 3
          call multiply
            read radius
            read radius
    case square
      send back
        call multiply
          read side
          read side
`)
  const sift = build(`${shape}
task area
  take s, like shape
  like number
  sift read s
    case circle
      send back
        call multiply
          code 3
          call multiply
            read radius
            read radius
    case square
      send back
        call multiply
          read side
          read side
`)

  same('1. `sift read s` emits what `fork case, read s` emits', fork, sift)
  ok('1. ...and that is a match on the tag', fork.ok && /case "circle"|\.form === "circle"|switch/.test(fork.ts), fork.ok ? fork.ts : fork.why)

  const leanFork = build(`${shape}
task area
  take s, like shape
  like number
  fork case, s
    case circle
      back multiply(3, multiply(radius, radius))
    case square
      back multiply(side, side)
`, true)
  const leanSift = build(`${shape}
task area
  take s, like shape
  like number
  sift s
    case circle
      back multiply(3, multiply(radius, radius))
    case square
      back multiply(side, side)
`, true)

  same('1. lean `sift s` emits what lean `fork case, s` emits', leanFork, leanSift)
  same('1. lean `sift s` emits what longhand `fork case, read s` emits', fork, leanSift)

  // a `case` arm's `link` renames and a fallback arm ride through unchanged (check/arm.ts is one rule for both)
  const linkFork = build(`${shape}
task size
  take s, like shape
  like number
  fork case, read s
    case circle
      link r
      send back, read r
    case square
      send back, code 0
`)
  const linkSift = build(`${shape}
task size
  take s, like shape
  like number
  sift read s
    case circle
      link r
      send back, read r
    case square
      send back, code 0
`)

  same('1. a renaming `link` under a `sift` arm binds as under `fork case`', linkFork, linkSift)
}

// ---- 2. `{x}` interpolates, and the compiler decides when ----

{
  const native = (b: Built) => (b.ok ? `${b.rs}\n${b.swift}\n${b.kotlin}` : '')
  const program = build(`
host per-day, 86400
host area, <north>
host started, now()

tree greeter
  take lang
  hook fuse
    task greet-{lang}
      take name, like text
      like text
      send back, <hello {name} in {lang}>

fuse greeter
  bind lang, english

task now
  like number
  send back, code 7

task folded
  like text
  send back, <{per-day} seconds in {area}>

task folded-call
  like text
  send back, <{add(per-day, per-day)} after>

task at-run
  take n, like number
  like text
  send back, <n is {n}>

task local
  like text
  save x, code 5
  send back, <x is {x}>

task late
  like text
  send back, <started {started}>

task shadow
  take area, like text
  like text
  send back, <in {area}>
`)

  ok('2. the program builds', program.ok, program.ok ? '' : program.why)

  if (program.ok) {
    const fn = (name: string) => {
      const at = program.ts.indexOf(`export function ${name}(`)
      return at < 0 ? '' : program.ts.slice(at, program.ts.indexOf('\n}\n', at) + 2)
    }

    // a template parameter: substituted when the template expands, the other hole left for run time
    ok('2. a template parameter is filled at expansion', /return `hello \$\{name\} in english`/.test(fn('greetEnglish')), fn('greetEnglish'))

    // a module constant that folds: a plain literal, no template literal, on every backend
    ok('2. a module constant is filled at compile time', /return "86400 seconds in north"/.test(fn('folded')), fn('folded'))
    ok('2. ...with no run-time interpolation left in it', !fn('folded').includes('`') && !fn('folded').includes('${'), fn('folded'))
    ok('2. ...nor on Rust, Swift or Kotlin', native(program).includes('"86400 seconds in north"') && !/format!\("\{\} seconds/.test(native(program)), native(program).slice(0, 400))
    ok('2. a call over module constants folds the same way', /return "172800 after"/.test(fn('foldedCall')), fn('foldedCall'))

    // anything else: filled at run time
    ok('2. a parameter is filled at run time', /return `n is \$\{n\}`/.test(fn('atRun')), fn('atRun'))
    ok('2. ...as `format!` on Rust', /format!\("n is \{\}"/.test(program.rs), program.rs.slice(0, 300))
    ok('2. a local is filled at run time', fn('local').includes('${') , fn('local'))
    ok('2. a constant that does not fold is filled at run time', /\$\{started\}/.test(fn('late')), fn('late'))
    ok('2. a parameter shadowing a module constant is the parameter', /\$\{area\}/.test(fn('shadow')), fn('shadow'))
  }

  const unknown = build(`
task greet
  like text
  send back, <hello {nobody}>
`)

  ok('2. a name in braces that names nothing is an unknown name', !unknown.ok && /nobody/.test(unknown.why), unknown.ok ? 'built' : unknown.why)

  const single = build(`
task greet
  take name, like text
  like text
  send back, <hello {name}>
`)
  const double = build(`
task greet
  take name, like text
  like text
  send back, <hello {{name}}>
`)

  same('2. `{{x}}` is still accepted and emits what `{x}` emits', single, double)

  const braces = build(`
task greet
  like text
  send back, <hello \\{name\\}>
`)

  ok('2. `\\{` and `\\}` stay the literal braces', braces.ok && /return "hello \{name\}"/.test(braces.ts), braces.ok ? braces.ts : braces.why)
}

// ---- 3. a comma after a call or a literal pops nothing ----

{
  const task = (body: string) => `task f\n  take n, like number\n  like boolean\n${body}\n`
  const parens = build(task('  back is-equal(add(n, 1), 14)'), true)
  const comma = build(task('  back is-equal add(n, 1), 14'), true)

  same('3. `back is-equal add(n, 1), 14` is `is-equal(add(n, 1), 14)`', parens, comma)

  const literal = shape('code <1>, <2>\nx y <1>, <2>\n')

  ok('3. a comma after a literal stays at the literal\'s level', literal === shape('code\n  <1>\n  <2>\nx\n  y\n    <1>\n    <2>\n'), literal)
}

// ---- 4 and 5. a simple value goes inline, and a view body takes the same shape ----

{
  const stacked = `form shape
  case circle
    link radius, like number

task total
  take xs
    like list
      like number
  like list
    like number
  save result
    make list
  is-equal
    text-cursor-peek(cursor)
    <,>
  back result

view home
  take host, like view
  view h1
    <Home>

view about
  take host, like view
  take who, like text
  view p
    who
`
  const formatted = format({ file: 'f.tree', text: stacked })

  // the fifth shape needs the comma rule: a comma after a closed call stays at its level
  const stackedWant = 'task found\n  want hold\n    is-equal\n      get(found, 1)\n      14\n'
  const fifth = format({ file: 'f.tree', text: stackedWant })

  ok('4. `term form` writes `want hold, is-equal get(found, 1), 14`', fifth.includes('  want hold, is-equal get(found, 1), 14\n'), fifth)
  ok('4. ...which parses to the stacked tree', shape(fifth) === shape(stackedWant))

  for (const line of [
    '  take xs, like list, like number',
    '  like list, like number',
    '  save result, make list',
    '  is-equal text-cursor-peek(cursor), <,>',
    '  view h1, <Home>',
    '  view p, who',
  ]) {
    ok(`4. \`term form\` writes \`${line.trim()}\``, formatted.split('\n').includes(line), `\n${formatted}`)
  }

  ok('4. a blank line still parts a task\'s signature from its body', /like list, like number\n\n  save result/.test(formatted), formatted)
  ok('4. the formatted file parses to the same tree', shape(stacked) === shape(formatted))
  ok('5. a top-level `view` definition stays stacked', formatted.includes('view about\n  take host'), formatted)
  ok('5. a placement with markup under it stays stacked', format({ file: 'f.tree', text: 'view a\n  view p\n    view b, <x>\n    view i, <y>\n' }).includes('  view p\n    view b, <x>'))
}

// ---- 5. a view placement takes a text or a bare variable, stacked or after a comma ----

{
  const page = (body: string) => `
view about
  take host, like view
  take who, like text
${body}
`
  const read = build(page('  view p\n    read who'))

  ok('5. `view p` over `read who` builds', read.ok, read.ok ? '' : read.why)

  for (const [label, body] of [
    ['`view p` over a bare `who`', '  view p\n    who'],
    ['`view p, who`', '  view p, who'],
  ] as const) {
    for (const lean of [false, true]) {
      const built = build(page(body), lean)

      ok(`5. ${label}${lean ? ' (lean)' : ''} builds`, built.ok, built.ok ? '' : built.why)

      if (built.ok && read.ok) {
        ok(`5. ${label}${lean ? ' (lean)' : ''} emits what \`view p\` over \`read who\` emits`, built.ts === read.ts)
      }
    }
  }

  const text = build(page('  view h1, <Home>'))
  const stackedText = build(page('  view h1\n    <Home>'))

  same('5. `view h1, <Home>` is `view h1` over `<Home>`', stackedText, text)
}

// ---- 4 and 5, as lint rules: `term lint --fix` makes the same layout, and the program does not change ----

{
  const lean = `form shape
  case circle
    link radius, like number
  case square
    link side, like number

task area
  take s, like shape
  like number

  fork case, s
    case circle
      back multiply(3, multiply(radius, radius))
    case square
      back
        multiply(side, side)

task label
  take n, like number
  like text

  back <n is {{n}}>
`
  const analysis = analyze({ file: 'l.tree', text: lean }, { lean: true })
  const findings = analysis.lint()
  const codes = findings.map(f => f.code)

  ok('1. L042 prefer-sift reports `fork case` in a lean file', codes.includes('L042'), codes.join(' '))
  ok('2. L043 prefer-single-brace reports `{{n}}`', codes.includes('L043'), codes.join(' '))
  ok('4. L044 line-layout reports `back` over one value', codes.includes('L044'), codes.join(' '))

  const fixed = applyFixes(lean, findings)

  ok('1. the L042 fix writes `sift s`', fixed.includes('  sift s\n    case circle'), fixed)
  ok('2. the L043 fix writes `<n is {n}>`', fixed.includes('back <n is {n}>'), fixed)
  ok('4. the L044 fix writes `back multiply(side, side)`', fixed.includes('    case square\n      back multiply(side, side)\n'), fixed)
  same('the fixed file emits what the written one emits', build(lean, true), build(fixed, true))

  const view = 'view about\n  take host, like view\n  take who, like text\n  view p\n    who\n  view h1\n    <Home>\n'
  const viewFixed = applyFixes(view, analyze({ file: 'v.tree', text: view }, { lean: true }).lint())

  ok('5. L044 collapses `view p` over `who` to `view p, who`', viewFixed.includes('  view p, who\n'), viewFixed)
  ok('5. ...and `view h1` over `<Home>` to `view h1, <Home>`', viewFixed.includes('  view h1, <Home>\n'), viewFixed)
  same('5. the collapsed view emits what the stacked one emits', build(view, true), build(viewFixed, true))

  // L044 is the five rules of format-rules.md "Where each part of a line goes", as `term form` lays them out. In a
  // lean file a bare head under a call is a LABEL or a call, and only the checker knows which, so a part written on
  // its own line stays there and one written closed stays closed: `shout` over `greet <ada>` is left alone, and
  // `shout` over `greet(<ada>)` joins as `shout greet(<ada>)`
  const spaced = 'task greet\n  take name, like text\n  like text\n\n  back name\n\ntask shout\n  take line, like text\n\n  back\n\ntask boot\n  shout\n    greet <ada>\n'
  const spacedCodes = analyze({ file: 's.tree', text: spaced }, { lean: true }).lint().map(f => f.code)

  ok('3. L044 leaves a lean argument written open on its own line (`shout` over `greet <ada>`)', !spacedCodes.includes('L044'), spacedCodes.join(' '))

  const closed = spaced.replace('greet <ada>', 'greet(<ada>)')
  const closedFixed = applyFixes(closed, analyze({ file: 's.tree', text: closed }, { lean: true }).lint().filter(f => f.code === 'L044'))

  ok('3. ...and joins one written closed: `shout greet(<ada>)`', closedFixed.includes('  shout greet(<ada>)\n'), closedFixed)
  same('3. ...which emits what the stacked call emits', build(spaced, true), build(closedFixed, true))

  // the page's own before and after: the fix writes the right-hand column, blank lines aside. Only L044's findings
  // are applied, since another rule's fix on the same line (`save` to `host` for a name never reassigned) wins an
  // overlap. Compared by milled program here, because this suite builds without the stdlib that holds `push`, `map`
  // and `sum`; the guide's copy of the sample is built against it (tmp/lean-guide/page.sh)
  const before = 'task list-demo\n  like number\n  save items\n    make list\n      3\n      1\n  push\n    items\n    2\n  save doubled\n    map\n      items\n      task twice\n        take n, like number\n        like number\n        back multiply(n, 2)\n  back sum(doubled)\n'
  const after = 'task list-demo\n  like number\n  save items, make list, 3, 1\n  push items, 2\n  save doubled\n    map items\n      task twice\n        take n, like number\n        like number\n        back multiply(n, 2)\n  back sum(doubled)\n'
  const demo = `load @term/base/list\n  find list\n\n${before}`
  const demoFixed = applyFixes(demo, analyze({ file: 'd.tree', text: demo }, { lean: true }).lint().filter(f => f.code === 'L044'))
  const dense = (text: string) => text.split('\n').filter(line => line.trim() !== '').join('\n')
  const programAt = (text: string) => {
    const parsed = parse({ file: 'd.tree', text })

    return parsed.ok ? programOf(parsed.tree, 'd.tree', true) : undefined
  }

  ok('1 to 5. the L044 fix writes format-rules.md\'s after column', dense(demoFixed) === dense(`load @term/base/list\n  find list\n\n${after}`), demoFixed)
  ok('1 to 5. ...and it mills to the program the before column mills to', programAt(demo) !== undefined && programAt(demo) === programAt(demoFixed))
  ok('1 to 5. the after column has no L044 finding', !analyze({ file: 'a.tree', text: `load @term/base/list\n  find list\n\n${after}` }, { lean: true }).lint().some(f => f.code === 'L044'))

  const longhandLayout = analyze({ file: 'l.tree', text: demo }, { lean: false })

  ok('L044 leaves a longhand file alone', !longhandLayout.lint().some(f => f.code === 'L044'))

  const longhand = analyze({ file: 'l.tree', text: 'form shape\n  case circle\n\ntask f\n  take s, like shape\n  fork case, read s\n    case circle\n      send back\n' }, { lean: false })

  ok('1. L042 leaves a longhand file alone', !longhand.lint().some(f => f.code === 'L042'))
}

console.log(`\n${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exitCode = 1
}
