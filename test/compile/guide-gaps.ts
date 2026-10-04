// Phase 1 of note/term/gaps/plan.md: programs the term.surf guides showed building clean and then behaving wrongly.
// Each block is the guide's own sample, held two ways where it can be: the wrong behavior is gone, and the right one
// (or a refusal that names the problem) is there. Where behavior is the point, the emitted TypeScript is run.
//
// Run: npx tsx test/compile/guide-gaps.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'

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

type Built = { ok: boolean; typescript: string; messages: string; names: string[]; warnings: string[] }

// `linked` resolves the stdlib and @term/site, for a sample that loads them
function build(text: string, file = '/gate/code/gap.tree', linked = false): Built {
  const out = compile(
    { file: linked ? join(TERM, 'test/compile/guide-gaps.tree') : file, text },
    linked ? { resolve: projectResolver(TERM, 'node'), env: 'node' } : {},
  )
  const warnings = ((out as { warnings?: { name: string; message: string }[] }).warnings ?? []).map(
    w => `${w.name}: ${w.message}`,
  )

  return out.ok
    ? { ok: true, typescript: out.typescript, messages: '', names: [], warnings }
    : {
        ok: false,
        typescript: '',
        messages: out.diagnostics.map(d => d.message).join(' | '),
        names: out.diagnostics.map(d => d.name),
        warnings,
      }
}

// the emitted module, imported, so its exports can be called
async function load(typescript: string): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'term-guide-gaps-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, typescript)

  return (await import(pathToFileURL(file).href)) as Record<string, (...args: unknown[]) => unknown>
}

async function main(): Promise<void> {
  // ---- language/loops: nested `walk size` loops each keep their own counter ----
  {
    const built = build(`task grid
  take n, like number
  like number
  save total, code 0
  walk size
    bind base, code 0
    bind head, read n
    hook next
      walk size
        bind base, code 0
        bind head, read n
        hook next
          save total
            call add
              read total
              code 1
  send back, read total
`)
    ok('two nested walk size loops build', built.ok, built.messages)

    if (built.ok) {
      const mod = await load(built.typescript)
      ok('and the outer loop ends, having run the inner one n times each turn', mod.grid!(4) === 16)
    }
  }

  // ---- language/loops: a `take` beside the `bind` lines names the counter ----
  {
    const built = build(`task sum-to
  take n, like number
  like number
  save total, code 0
  walk size
    take j
    bind base, code 0
    bind head, read n
    hook next
      save total
        call add
          read total
          read j
  send back, read total
`)
    ok('a take beside the bind lines names the counter', built.ok, built.messages)

    if (built.ok) {
      const mod = await load(built.typescript)
      ok('and the body reads it', mod.sumTo!(5) === 10)
    }
  }

  // ---- language/branching: a path that can end without `back` ----
  {
    const refused = build(`task no-miss
  take n, like number
  like text
  fork test
    hook test
      call is-below
        read n
        code 0
    hook hold
      send back, text <negative>
`)
    ok('a task promising text with no miss arm is refused', refused.names.includes('missing-back'), refused.messages)

    const whole = build(`task all-paths
  take n, like number
  like text
  fork test
    hook test
      call is-below
        read n
        code 0
    hook hold
      send back, text <negative>
    hook miss
      send back, text <not negative>
`)
    ok('and one that returns on every path builds', whole.ok, whole.messages)
  }

  // ---- language/branching: an arm with a word the fork does not know ----
  {
    const built = build(`task sign-word
  take n, like number
  like text
  fork test
    hook test
      call is-below
        read n
        code 0
    hook true
      send back, text <negative>
  send back, text <not negative>
`)
    ok('`hook true` under `fork test` is refused, not dropped', !built.ok && /true/.test(built.messages), built.messages)
  }

  // ---- language/errors: `halt <text>` raises `failure`, a TermException a handler can read ----
  {
    const built = build(`task boom
  like number
  halt <nope>
`)
    ok('halt with text builds', built.ok, built.messages)

    if (built.ok) {
      const mod = await load(built.typescript)
      let caught: { name?: string; form?: string } = {}

      try {
        mod.boom!()
      } catch (error) {
        caught = error as typeof caught
      }

      ok('and throws the TermException carrier with form failure', caught.name === 'TermException' && caught.form === 'failure', JSON.stringify(caught))
    }
  }

  // ---- language/notes: `mark <uuid>` under a form is its identity ----
  {
    const built = build(`form person
  mark <3f2a9c4e-1b7d-4e8a-9f60-2c5d8b7e1a03>
  link name, like text

task make-ada
  like person
  send back
    make person
      bind name, text <ada>
`)
    ok('a form carrying `mark <uuid>` builds', built.ok, built.messages)
  }

  // ---- language/notes: an unknown mark word is refused ----
  {
    const built = build(`task old-way
  mark deprecatd
  like number
  send back, code 1
`)
    ok('`mark deprecatd` is refused', !built.ok && /deprecatd/.test(built.messages), built.messages)

    // a file's marks under a task were accepted and read by nothing
    for (const word of ['draft', 'stable', 'unstable']) {
      const filed = build(`task old-way
  mark ${word}
  like number
  send back, code 1
`)
      ok(`\`mark ${word}\` under a task is refused as a file's mark`, !filed.ok && /marks a file/.test(filed.messages), filed.messages)
    }

    const exact = build(`task old-way
  mark exact
  like number
  send back, code 1
`)
    ok('`mark exact`, which nothing reads yet, is refused', !exact.ok && /exact/.test(exact.messages), exact.messages)
  }

  // ---- language/notes: `mark native` under a `dock load` repeats what `dock` says ----
  {
    const marked = build(`dock load
  load <node:path>, name path
  mark native

task base-name
  take file, like text
  like text
  send back
    call path/basename
      read file
`)
    ok('`mark native` under `dock load` is refused, naming the dock', !marked.ok && /mark native.*dock load/.test(marked.messages), marked.messages)

    const bare = build(`dock load
  load <node:path>, name path

task base-name
  take file, like text
  like text
  send back
    call path/basename
      read file
`)
    ok('and the same dock without it builds', bare.ok, bare.messages)
  }

  // ---- language/forms and language/tasks: what is left out is refused, not filled ----
  {
    const field = build(`form person
  link name, like text
  link age, like number

task nameless-age
  like person
  send back
    make person
      bind name, text <ada>
`)
    ok('a required field left out is refused', !field.ok && /age/.test(field.messages), field.messages)

    const argument = build(`task greet
  take name, like text
  take punct, like text
  like text
  send back, text <{name}{punct}>

task use-greet
  like text
  send back
    call greet
      text <ada>
`)
    ok('a text argument left out is refused', !argument.ok && /punct/.test(argument.messages), argument.messages)
  }

  // ---- language/variables: a misspelled save is warned about ----
  {
    const built = build(`task typo
  take count, like number
  like number
  save total, code 0
  save totl
    call add
      read total
      read count
  send back, read total
`)
    ok('the misspelled binding is named as never used', built.warnings.some(w => /totl/.test(w)), built.warnings.join(' | '))
  }

  // ---- types: a type name that names nothing ----
  {
    const built = build(`task first-of
  take x, like widgett
  like number
  send back, code 1
`)
    ok('`like widgett` is refused', !built.ok && /widgett/.test(built.messages), built.messages)
  }

  // ---- language/values: number literals and `host` ----
  {
    const past = build(`task huge
  like number
  send back, code 99999999999999999999
`)
    ok('a literal past 64 bits is refused', !past.ok, past.messages)

    const unsafe = build(`task big
  like number
  send back, code 9007199254740993
`)
    ok('a literal past 2^53 builds with a warning naming what TypeScript reads', unsafe.ok && unsafe.warnings.some(w => /9007199254740992/.test(w)), unsafe.warnings.join(' | '))

    const twice = build(`task limit-twice
  like number
  host limit, code 10
  save limit, code 20
  send back, read limit
`)
    ok('a save after a host of one name is refused', !twice.ok && /limit/.test(twice.messages), twice.messages)
  }

  // ---- types/annotations: a width alias holds its range at a literal ----
  {
    const SHADE = `task shade
  take level, like u8
  like number
  send back, read level
`
    const over = build(`${SHADE}
task use-shade
  like number
  send back
    call shade
      code 300
`)
    ok('300 for a u8 parameter is refused', !over.ok && /u8/.test(over.messages), over.messages)

    const named = build(`${SHADE}
task use-shade
  like number
  send back
    call shade
      bind level, code -1
`)
    ok('and so is -1 passed by name', !named.ok && /u8/.test(named.messages), named.messages)

    const inside = build(`${SHADE}
task use-shade
  like number
  send back
    call shade
      code 255
`)
    ok('255 builds', inside.ok, inside.messages)
  }

  // ---- language/native: a call that can only reach a stub ----
  {
    // a module that declares a task and never fills it, and a file that calls it
    const LIBRARY = `task later
  take n, like number
  like number
`
    const library = (path: string) => (path === './later' ? { file: '/gate/code/later.tree', text: LIBRARY } : undefined)
    const out = compile(
      {
        file: '/gate/code/gap.tree',
        text: `load ./later
  find later

task use-later
  like number
  send back
    call later
      code 2
`,
      },
      { resolve: library },
    )
    const messages = out.ok ? '' : out.diagnostics.map(d => d.message).join(' | ')
    ok('a call into another module\'s task with no body anywhere is refused', !out.ok && /later\.tree/.test(messages), messages)

    const own = build(`task later
  take n, like number
  like number

task use-later
  like number
  send back
    call later
      code 2
`)
    ok('a file calling a body-less task it declares itself builds: an uninterpreted constant', own.ok, own.messages)
  }

  // ---- language/tasks: labels and duplicates ----
  {
    const labels = build(`form counter
  link count, like number

  task bump
    take self
    take by, like number
    like number
    send back
      call add
        read self/count
        read by

task use-bump
  take c, like counter
  like number
  send back
    call bump
      bind by, code 2
      bind counter, read c
`)
    ok('method arguments out of the method order are refused, naming the order', !labels.ok && /self, by/.test(labels.messages), labels.messages)

    const twice = build(`task area
  take w, like number
  like number
  send back, read w

task area
  take w, like number
  like number
  send back
    call multiply
      read w
      read w
`)
    ok('two tasks of one name and one signature in one file are refused', twice.names.includes('duplicate-definition'), twice.messages)
  }

  // ---- applications/web/fetching: a `find` of a name the module does not define ----
  {
    const built = build(
      `load @term/base/list
  find no-such-task

task use
  like number
  send back, code 1
`,
      undefined,
      true,
    )
    ok('a stale find is refused', !built.ok && /no-such-task/.test(built.messages), built.messages)
  }

  // ---- parsers/cursor: a write through a value parameter that reaches nobody ----
  {
    const lost = build(`form counter
  link count, like number

task bump
  take box, like counter
  save box/count, add(box/count, 1)
`)
    ok('a write to a value record nobody gets back is refused', !lost.ok && /box/.test(lost.messages), lost.messages)

    const through = build(`form element-box
  link handle, mark private

task set-it
  take node, like element-box
  save node/handle/text, <x>
`)
    ok('a write through an opaque handle reaches the shared object, and builds', through.ok, through.messages)
  }

  // ---- applications/web/routes: what a page route keeps and refuses ----
  {
    const PAGE = `load @term/site/dom/dom
  find view

view page
  take host, like view
  view span
    <hi>
`
    const seeded = build(
      `${PAGE}
hook /about
  seed title, <About>
  seed description, <Who we are>
  view page
`,
      undefined,
      true,
    )
    ok('seed title and seed description reach the page', seeded.ok && /setTitle\("About"\)/.test(seeded.typescript) && /setMeta\("description", "Who we are"\)/.test(seeded.typescript), seeded.messages)

    const method = build(
      `${PAGE}
hook /data
  task get
    send back, <ok>
`,
      undefined,
      true,
    )
    ok('a page route with `task get` is refused, not emitted as nothing', method.names.includes('not-implemented'), method.messages)
  }

  // ---- applications/web/components: the lowered component is typed and checked ----
  {
    const HEAD = `load @term/site/dom/dom
  find view

load @term/site/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/base/text/string
  find to-text

form item
  link name, like text
  link done, like boolean
`
    const typed = build(
      `${HEAD}
view counter
  take host, like view
  save count, make-signal(0)
  view p
    read to-text(read-signal(count))

view panel
  take host, like view
  take title, like text
  view section
    view h2
      read title
    site

view checklist
  take host, like view
  take items, like list, like item
  view panel
    bind title, <To do>
    view ul
      walk list, read items
        hook next
          take site, name row
          view li
            read row/name
`,
      undefined,
      true,
    )
    ok('the components sample builds', typed.ok, typed.messages)
    ok('a component returns void', /export function counter\(host: View\): void/.test(typed.typescript))
    ok('the children closure takes a View', /\(view\d+: View\) =>/.test(typed.typescript))
    ok('a walk over `like list, like item` types its row', /\(row: Item\) =>/.test(typed.typescript))

    const number = build(
      `${HEAD}
view counter
  take host, like view
  save count, make-signal(0)
  view p
    read read-signal(count)
`,
      undefined,
      true,
    )
    ok('a number read into a text node is refused', !number.ok && /String|text/i.test(number.messages), number.messages)
  }

  console.log(`\nguide-gaps: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

void main()
