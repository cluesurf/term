// Await by default, `tick` to fire, and `mark` for all metadata (note/project/term/await-by-default-and-mark-metadata.md).
// Each claim is held by what the compiler EMITS on TypeScript, Rust, Swift and Kotlin, never by what the parser builds
// alone:
//
//   1. a call to an async task is awaited with nothing written, and `wait true` emits the same
//   2. `tick f(x)` is `call f / wait false`: started, not waited for, the pending value in a value position
//   3. the errors: `tick` on a task that is not async, and (behind the switch) an un-ticked async call outside a task
//   4. `mark <word>` emits what `note <word>` emits, for every metadata word, and the other `mark`s keep their meaning
//   5. the warning and the two lint rules with their fixes
//
// Run: npx tsx test/compile/await-mark.ts

import {
  compile,
  setAwaitOutsideTasks,
  awaitsOutsideTasks,
} from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import { analyze } from '@term/make/code/analyze'
import { applyFixes } from '@term/make/code/lint/lint'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { format } from '@term/make/code/format/format'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'

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

type Built =
  | {
      ok: true
      ts: string
      rs: string
      swift: string
      kotlin: string
      warnings: string[]
    }
  | { ok: false; why: string }

const FILE = '/gate/code/await.tree'

// TypeScript only, with the standard library resolved, for a program that loads a module of it (the task module a
// ticked value needs)
function buildWithBase(
  text: string,
): { ok: true; ts: string } | { ok: false; why: string } {
  const out = compile(
    { file: FILE, text },
    { resolve: withNativeEnv('node', stdlibResolver()!) },
  )

  return out.ok
    ? { ok: true, ts: out.typescript }
    : {
        ok: false,
        why: out.diagnostics.map(d => d.message).join(' | '),
      }
}

function build(text: string, lean = false): Built {
  const out = compile({ file: FILE, text }, { leanOf: () => lean })

  if (!out.ok) {
    return {
      ok: false,
      why: out.diagnostics.map(d => d.message).join(' | '),
    }
  }

  const native = (env: 'rust' | 'swift' | 'kotlin') => {
    const result = compile(
      { file: FILE, text },
      { leanOf: () => lean, env },
    )

    return result.ok ? result.program : []
  }

  return {
    ok: true,
    ts: out.typescript,
    rs: emitRust(native('rust')),
    swift: emitSwift(native('swift')),
    kotlin: emitKotlin(native('kotlin')),
    warnings: out.warnings.map(w => w.name ?? ''),
  }
}

function same(name: string, a: Built, b: Built, natives = true): void {
  if (!a.ok || !b.ok) {
    ok(name, false, `${a.ok ? '' : a.why} ${b.ok ? '' : b.why}`)
    return
  }

  ok(`${name}: TypeScript`, a.ts === b.ts, `\n${a.ts}\n---\n${b.ts}`)

  if (natives) {
    // an empty native program on both sides would compare equal and prove nothing
    ok(
      `${name}: every native backend built`,
      /\bfn \w/.test(a.rs) &&
        /\bfunc \w/.test(a.swift) &&
        /\bfun \w/.test(a.kotlin),
    )
    ok(`${name}: Rust`, a.rs === b.rs)
    ok(`${name}: Swift`, a.swift === b.swift)
    ok(`${name}: Kotlin`, a.kotlin === b.kotlin)
  }
}

const FETCH = `
task fetch-page
  mark async
  take url, like text
  like text
  send back, read url
`

// ---- 1. await by default ----

{
  const plain = build(`${FETCH}
task read-both
  take a, like text
  take b, like text
  like text
  save x, call fetch-page(read a)
  save y, call fetch-page(read b)
  send back, read y
`)
  const marked = build(`${FETCH}
task read-both
  take a, like text
  take b, like text
  like text
  save x
    call fetch-page
      read a
      wait true
  save y
    call fetch-page
      read b
      wait true
  send back, read y
`)

  same(
    '1. a call to an async task with nothing written emits what `wait true` emits',
    plain,
    marked,
  )
  ok(
    '1. ...and TypeScript awaits it, the caller async',
    plain.ok &&
      /async function readBoth/.test(plain.ts) &&
      /= await fetchPage\(a\)/.test(plain.ts),
    plain.ok ? plain.ts : plain.why,
  )
  ok(
    '1. ...Rust awaits it with `.await`',
    plain.ok && /fetch_page\(a\)\.await/.test(plain.rs),
    plain.ok ? plain.rs.slice(-600) : '',
  )
  ok(
    '1. ...Swift with a prefix `await`',
    plain.ok && /await fetchPage\(url: a\)/.test(plain.swift),
  )
  ok(
    '1. ...Kotlin through `suspend`',
    plain.ok && /suspend fun readBoth/.test(plain.kotlin),
  )
}

// ---- 2. `tick` ----

{
  const ticked = build(`${FETCH}
task log-visit
  take url, like text
  like text
  tick fetch-page(read url)
  send back, read url
`)
  const waitFalse = build(`${FETCH}
task log-visit
  take url, like text
  like text
  call fetch-page
    read url
    wait false
  send back, read url
`)

  same(
    '2. `tick fetch-page(url)` emits what `call fetch-page / wait false` emits',
    ticked,
    waitFalse,
  )
  ok(
    '2. ...the call is made and not awaited, and the caller stays synchronous',
    ticked.ok &&
      /^export function logVisit/m.test(ticked.ts) &&
      /^\s+fetchPage\(url\)$/m.test(ticked.ts),
    ticked.ok ? ticked.ts : ticked.why,
  )

  const stacked = build(`${FETCH}
task log-visit
  take url, like text
  like text
  tick fetch-page
    read url
  send back, read url
`)

  same(
    '2. `tick f` over its arguments is the same call as `tick f(x)`',
    ticked,
    stacked,
  )

  // in a value position a tick is the pending JOB, `spawn` of the call, a `handle` of its answer (check/pending.ts). It
  // was a Promise on TypeScript with the binding left to inference, and nothing at all natively, until 2026-10-05
  const pending = buildWithBase(`load @term/base/task
  find spawn

${FETCH}
task start
  take url, like text
  like unknown
  save work, tick fetch-page(read url)
  send back, read work
`)

  // `spawn` docks the job runtime, so it can raise `failure` and its call records its Term frame first (term/hive
  // decision 001): `(__site = "<frame>", spawn(...))`
  ok(
    '2. in a value position `tick` is the pending job, a `handle` of the answer',
    pending.ok &&
      /const work: Handle<string> = (\(__site = "[^"]*", )?spawn\(async \(\) => \(await fetchPage\(url\)\)\)/.test(
        pending.ts,
      ),
    pending.ok ? pending.ts : pending.why,
  )

  const unloaded = build(`${FETCH}
task start
  take url, like text
  like unknown
  save work, tick fetch-page(read url)
  send back, read work
`)

  ok(
    '2. ...and without the task module it is refused, naming what to load',
    !unloaded.ok &&
      /load @term\/base\/task and find spawn/.test(unloaded.why),
    unloaded.ok ? 'built' : unloaded.why,
  )

  const lean = build(
    `${FETCH}
task log-visit
  take url, like text
  like text
  tick fetch-page(url)
  back url
`,
    true,
  )

  same(
    '2. lean `tick fetch-page(url)` emits what longhand `tick fetch-page(read url)` emits',
    ticked,
    lean,
  )

  const waited = build(`${FETCH}
task log-visit
  take url, like text
  like text
  tick fetch-page
    read url
    wait true
  send back, read url
`)

  ok(
    '2. `wait true` under a `tick` is refused, since the two say opposite things',
    !waited.ok && /does not wait for it/.test(waited.why),
    waited.ok ? 'built' : waited.why,
  )
}

// ---- 3. the errors ----

{
  const onSync = build(`
task double
  take x, like number
  like number
  send back, read x

task caller
  take x, like number
  like number
  tick double(read x)
  send back, read x
`)

  ok(
    '3. `tick` on a task that is not async is an error naming the task',
    !onSync.ok && /"double" is not async/.test(onSync.why),
    onSync.ok ? 'built' : onSync.why,
  )

  const outside = `${FETCH}
host page, call fetch-page(<home>)
`
  const before = awaitsOutsideTasks()

  setAwaitOutsideTasks(false)
  const old = build(outside)
  setAwaitOutsideTasks(true)
  const now = build(outside)
  const fixed = buildWithBase(`load @term/base/task
  find spawn

${FETCH}
host page, tick fetch-page(<home>)
`)
  setAwaitOutsideTasks(before)

  ok(
    '3. with the switch off, an async call in a top-level `host` builds, un-awaited (the old rule)',
    old.ok && /const page[^=]*= fetchPage\("home"\)/.test(old.ts),
    old.ok ? old.ts : old.why,
  )
  ok(
    '3. with it on, the same call is an error naming `tick`',
    !now.ok &&
      /outside any task/.test(now.why) &&
      /tick fetch-page/.test(now.why),
    now.ok ? 'built' : now.why,
  )
  // a ticked `host` is a value, so it is the pending job too, started where the module loads
  // outside every task the raising call is wrapped once in `__termTop("<frame>", () => ...)` (term/hive decision 001)
  ok(
    '3. ...and `tick` there builds, the host holding the pending job',
    fixed.ok &&
      /const page: Handle<string> = (__termTop\("[^"]*", \(\) => )?spawn\(async \(\) => \(await fetchPage\("home"\)\)\)/.test(
        fixed.ts,
      ),
    fixed.ok ? fixed.ts : fixed.why,
  )

  const insideTask = build(`${FETCH}
task caller
  take url, like text
  like text
  send back, call fetch-page(read url)
`)

  ok(
    '3. inside a task the switch changes nothing: the call is awaited',
    insideTask.ok && /await fetchPage\(url\)/.test(insideTask.ts),
  )
}

// ---- 4. `mark` is the metadata word ----

{
  const pair = (
    name: string,
    body: (word: 'mark' | 'note') => string,
    natives = true,
  ): void => {
    same(
      `4. ${name}`,
      build(body('note')),
      build(body('mark')),
      natives,
    )
  }

  pair(
    '`mark async` emits what `note async` emits',
    w => `
task fetch-page
  ${w} async
  take url, like text
  like text
  send back, read url

task caller
  take url, like text
  like text
  send back, call fetch-page(read url)
`,
  )

  // a guarded block is a `fork` with `mark unsafe` on it (2026-10-06): either word holding statements of its own is
  // refused, naming the fork, and test/compile/guard.ts holds the fork itself on every backend
  for (const word of ['note', 'mark'] as const) {
    const guarded = build(`
task risky
  take x, like number
  like number
  ${word} unsafe
    halt <bad>
  halt take
    take e
    send back, code 0
  send back, read x
`)

    ok(
      `4. \`${word} unsafe\` over statements is refused, naming \`fork\` / \`mark unsafe\``,
      !guarded.ok && /a guarded block is a `fork`/.test(guarded.why),
      guarded.ok ? 'built' : guarded.why,
    )
  }

  pair(
    '`mark roam` emits what `note roam` emits',
    w => `
task serve
  ${w} roam
  take x, like number
  like number
  send back, read x
`,
  )

  pair(
    '`mark deprecated` on a task emits what the note emits',
    w => `
task old-way
  ${w} deprecated
  take x, like number
  like number
  send back, read x
`,
  )

  // a word read by nothing is refused in either spelling, so a program cannot carry a mark that means nothing
  // (guides: language/notes, 2026-10-04)
  const refused = (
    name: string,
    body: (word: 'mark' | 'note') => string,
    pattern: RegExp,
  ): void => {
    for (const word of ['note', 'mark'] as const) {
      const built = build(body(word))

      ok(
        `4. ${name}, as \`${word}\``,
        !built.ok && pattern.test(built.why),
        built.ok ? 'built' : built.why,
      )
    }
  }

  refused(
    '`keep` on a task is refused',
    w => `
task old-way
  ${w} keep
  take x, like number
  like number
  send back, read x
`,
    /mark keep/,
  )

  pair(
    '`mark stable` at the top of a file emits what `note stable` emits',
    w => `${w} stable

task one
  like number
  send back, code 1
`,
  )

  refused(
    '`native` under a dock load is refused',
    w => `
dock load
  load <node:fs/promises>, name fs-promise
  ${w} native

task one
  like number
  send back, code 1
`,
    /dock load/,
  )

  // a claim left open: `mark open` keeps it open the way `note open` did, counted rather than refused
  const claim = (w: string) =>
    compile({
      file: FILE,
      text: `
rule twice
  ${w} open
  take x, like number
  like number
`,
    })
  const noteOpen = claim('note')
  const markOpen = claim('mark')

  ok(
    '4. `mark open` on a claim leaves it open, as `note open` does',
    noteOpen.ok &&
      markOpen.ok &&
      JSON.stringify(noteOpen.openClaims) ===
        JSON.stringify(markOpen.openClaims) &&
      (markOpen.openClaims ?? []).includes('twice'),
    JSON.stringify([
      noteOpen.ok
        ? noteOpen.openClaims
        : noteOpen.diagnostics.map(d => d.message),
      markOpen.ok
        ? markOpen.openClaims
        : markOpen.diagnostics.map(d => d.message),
    ]),
  )

  const unopened = compile({
    file: FILE,
    text: '\nrule twice\n  take x, like number\n  like number\n',
  })

  ok(
    '4. ...and without it the same claim is refused, so the mark is what kept it open',
    !unopened.ok,
  )

  // a theorem's variable is a `seat` (2026-10-05), so a variable named like a metadata word cannot collide with it
  const binderText = (word: string) => `
rule add-zero
  ${word} open, like number
  show hold
    call is-equal
      call add
        read open
        code 0
      read open
`
  const binder = compile({ file: FILE, text: binderText('seat') })

  ok(
    '4. inside a rule, `seat open, like number` is a universal binder',
    binder.ok,
    binder.ok ? '' : binder.diagnostics.map(d => d.message).join(' | '),
  )

  const oldBinder = compile({ file: FILE, text: binderText('mark') })

  ok(
    '4. ...and `mark open, like number`, the old spelling, is refused by name rather than dropped',
    !oldBinder.ok &&
      oldBinder.diagnostics.some(d =>
        d.message.includes('old spelling of a theorem'),
      ),
    oldBinder.ok
      ? 'it compiled'
      : oldBinder.diagnostics.map(d => d.message).join(' | '),
  )

  // a record's identity mills exactly as before (the same claim test/compile/retired.ts makes): a text literal is
  // not one of the metadata words, so `mine mark-note` never sees it
  const identity = parse({
    file: 'u.tree',
    text: 'form thing\n  mark <0f7c8a12-4b3e-4c1d-9a2f-6e5d4c3b2a19>\n  link name, like text\n',
  })
  const identityMilled = identity.ok
    ? mill(identity.tree, 'u.tree')
    : undefined

  ok(
    '4. `mark <uuid>` on a form still mills as it did, not as metadata',
    identityMilled?.ok === true &&
      !JSON.stringify(identityMilled.program).includes('"note"'),
    identityMilled && !identityMilled.ok
      ? identityMilled.diagnostics[0]?.message
      : '',
  )

  const field = build(`
form box
  link dock, mark private
  link size, like number

task size-of
  take b, like box
  like number
  send back, read b/size
`)

  ok(
    '4. `mark private` on a field is still field privacy',
    field.ok,
    field.ok ? '' : field.why,
  )

  const privateTask = compile({
    file: FILE,
    text: '\ntask helper\n  mark private\n  like number\n  send back, code 1\n',
  })

  ok(
    '4. `mark private` on a task is still task privacy, with no warning',
    privateTask.ok &&
      !privateTask.warnings.some(
        w => w.name === 'note-private' || w.name === 'note-metadata',
      ),
  )

  const documented = build(`
form upload-excess
  like excess
  bind note, <Upload too large>
  link limit, like number
`)

  ok(
    '4. a field NAMED note (`bind note, <...>` on an exception) is not metadata and not warned',
    documented.ok
      ? !documented.warnings.includes('note-metadata')
      : !/note-metadata/.test(documented.why),
    documented.ok ? documented.warnings.join(',') : documented.why,
  )
}

// ---- 5. the warning and the lint rules ----

{
  const old = build(`${FETCH.replace('mark async', 'note async')}
task caller
  like text
  send back, call fetch-page(<x>)
`)
  const current = build(`${FETCH}
task caller
  like text
  send back, call fetch-page(<x>)
`)

  ok(
    '5. `note async` builds and warns `note-metadata`',
    old.ok && old.warnings.includes('note-metadata'),
    old.ok ? old.warnings.join(',') : old.why,
  )
  ok(
    '5. `mark async` builds with no such warning',
    current.ok && !current.warnings.includes('note-metadata'),
  )

  const source = `note stable

task fetch-page
  note async
  take url, like text
  like text
  send back, read url

task risky
  take x, like number
  like number
  note unsafe
    halt <bad>
  halt take
    take e
    send back, code 0
  send back, read x
`
  const findings = analyze({ file: 'n.tree', text: source }).lint()
  const l053 = findings.filter(f => f.code === 'L053')

  ok(
    '5. L053 finds every metadata `note`: the file mark, the async and the guard',
    l053.length === 3,
    findings.map(f => `${f.code} ${f.message}`).join('\n'),
  )

  const fixed = applyFixes(source, l053)

  // a guard's `note unsafe` holds statements, and a block is a `fork` (2026-10-06): the fix writes `fork` / `mark unsafe`
  ok(
    '5. ...its fix writes `mark` for each, the guard as `fork` / `mark unsafe`',
    !/^\s*note /m.test(fixed) &&
      /^mark stable$/m.test(fixed) &&
      /^  mark async$/m.test(fixed) &&
      /^  fork\n    mark unsafe\n    halt <bad>$/m.test(fixed),
    fixed,
  )
  const written = source
    .replace(/^note stable$/m, 'mark stable')
    .replace(/^  note async$/m, '  mark async')
    .replace(/^  note unsafe$/m, '  fork\n    mark unsafe')
  same(
    '5. ...and the fixed file emits what the same program written by hand emits',
    build(written),
    build(fixed),
  )

  // the formatter lays `mark async` out where it laid `note async`, so the rewrite moves no line
  const laid =
    'task boot\n  note async\n  take x, like text\n  like text\n  log <hi>\n'
  ok(
    '5. `term form` lays out `mark async` exactly as it laid out `note async`',
    format({ file: 'f.tree', text: laid.replace('note', 'mark') }) ===
      format({ file: 'f.tree', text: laid }).replace('note', 'mark'),
    format({ file: 'f.tree', text: laid.replace('note', 'mark') }),
  )

  const waits = `${FETCH}
dock load
  load <node:fs/promises>, name fs-promise

task caller
  take url, like text
  like text
  save x
    call fetch-page
      read url
      wait true
  save y, call fetch-page(read url), wait true
  call fs-promise/append-file
    text <log>
    read x
    wait true
  send back, read y
`
  const l054 = analyze({ file: 'w.tree', text: waits })
    .lint()
    .filter(f => f.code === 'L054')

  ok(
    '5. L054 finds the two `wait true`s on the async task and leaves the host call alone',
    l054.length === 2,
    l054.map(f => f.message).join('\n'),
  )

  const dropped = applyFixes(waits, l054)

  ok(
    '5. ...its fix removes the line and the `, wait true`',
    (dropped.match(/wait true/g) ?? []).length === 1 &&
      /save y, call fetch-page\(read url\)\n/.test(dropped),
    dropped,
  )
  same(
    '5. ...and the fixed file emits what the written one emits',
    build(waits),
    build(dropped),
    false,
  )
}

// a call to an async task inside a text's `{...}` is awaited like any other. The rewrite had no `template` case, so
// `log <with one: {status-with(...)}>` printed `with one: [object Promise]` (guides: library/network, 2026-10-04)
{
  const built = build(`task later
  mark async
  take n, like number
  like number
  send back, read n

task shown
  like text
  send back, <in a text: {later(3)}>
`)
  ok(
    'an async call in a text interpolation builds',
    built.ok,
    built.ok ? '' : built.why,
  )

  if (built.ok) {
    ok(
      'and is awaited in the TypeScript',
      /\$\{await later\(3\)\}/.test(built.ts),
      built.ts.slice(-300),
    )
    ok(
      'and in the Rust',
      /later\(3\)\.await/.test(built.rs),
      built.rs.slice(-400),
    )
    ok(
      'and in the Swift',
      /await later\(n: 3\)/.test(built.swift),
      built.swift.slice(-400),
    )
    ok(
      'and the task holding it is async in the Kotlin',
      /suspend fun shown/.test(built.kotlin),
      built.kotlin.slice(-400),
    )
  }
}

// ASYNC IS PART OF A TASK TYPE (term/compiler decision 006): an async task literal bound to a field typed `like task`
// without `mark async` is refused at the bind, naming the fix; a task literal that is not async bound to a field that is
// `mark async` is made async (check/async-slots.tree) and runs on every backend
{
  const refused = buildWithBase(`form slot
  link work
    like task
      like text

task make-slot
  like slot
  send back
    make slot
      bind work
        task inner
          mark async
          like text
          send back, text <x>
`)
  ok(
    '6. an async task into a task that is not async is refused, naming mark async',
    !refused.ok &&
      /an async task where a task that is not async is wanted/.test(
        refused.why,
      ),
    refused.ok ? 'built' : refused.why,
  )

  const SYNC_INTO_ASYNC = `form job
  link work
    like task
      mark async
      like text

task run-work
  mark async
  take work
    like task
      mark async
      like text
  like text
  send back
    call work

task run-job
  mark async
  take one, like job
  like text
  send back
    call run-work
      read one/work

task run
  mark async
  like text
  save plain
    make job
      bind work
        task plain-work
          like text
          send back, text <sync>
  save first
    call run-job
      read plain
  send back, read first
`
  const dir = mkdtempSync(join(tmpdir(), 'term-await-mark-'))

  for (const backend of BACKENDS) {
    const ran = runOn({
      backend,
      program: SYNC_INTO_ASYNC,
      resolve: env => projectResolver(process.cwd(), env),
      dir,
      name: 'sync-into-async',
    })

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${ran.reason}`)
      continue
    }

    ok(
      `6. ${backend}: a task that is not async bound to a mark async field builds and runs`,
      ran.form === 'ran' && ran.output === 'sync',
      ran.form === 'ran' ? ran.output : `${ran.stage}: ${ran.reason}`,
    )
  }
}

// 7. A CALL THROUGH A LOCAL HOLDING AN ASYNC TASK IS AWAITED (term-compiler-0062): `save work, read one/work` then
// `call work` was not, since async resolution counted a name as async only when it named an async task or an async
// parameter. Rust handed back the boxed future where a String was wanted (E0308), Swift called an async closure without
// await. 8. A call written `who/ask(n)` through a field typed as an async task, in a walk, is awaited
// (term-compiler-0061, the scan lane's `source/gather(nodes)`)
{
  const LOCAL_ASYNC = `form job
  link work
    like task
      mark async
      like text

task later
  mark async
  like text
  send back, text <late>

task run-job
  take one, like job
  like text
  save work, read one/work
  send back
    call work

task run-later
  like text
  save named, read later
  send back
    call named

task run
  mark async
  like text
  save one
    make job
      bind work, read later
  save first
    call run-job
      read one
  save second
    call run-later
  send back, text <{first} {second}>
`
  const FIELD_IN_WALK = `form asker
  link ask
    like task
      mark async
      take n, like number
      like text

task said
  mark async
  take n, like number
  like text
  send back, text <n>

task run-all
  take who, like asker
  like text
  save out, text <>
  save turns, code 0
  walk test
    hook test, is-below(turns, 1)
    hook hold
      save got
        call who/ask
          code 1
      save out, text <{out}{got}>
      save turns, add(turns, 1)
  send back, read out

task run
  mark async
  like text
  save one
    make asker
      bind ask, read said
  send back
    call run-all
      read one
`
  const dir = mkdtempSync(join(tmpdir(), 'term-await-local-'))

  for (const backend of BACKENDS) {
    for (const [label, program, expected] of [
      [
        '7. a call through a local holding an async task (a field read, a task named) is awaited',
        LOCAL_ASYNC,
        'late late',
      ],
      [
        '8. a call written who/ask through an async field, in a loop, is awaited',
        FIELD_IN_WALK,
        'n',
      ],
    ] as const) {
      const ran = runOn({
        backend,
        program,
        resolve: env => projectResolver(process.cwd(), env),
        dir,
        name: label.slice(0, 1) === '7' ? 'local-async' : 'field-walk',
      })

      if (ran.form === 'skipped') {
        console.log(`skip  ${backend}: ${ran.reason}`)
        continue
      }

      ok(
        `${label}: ${backend}`,
        ran.form === 'ran' && ran.output.trim() === expected,
        ran.form === 'ran'
          ? ran.output
          : `${ran.stage}: ${ran.reason.slice(0, 600)}`,
      )
    }
  }
}

console.log(`\nawait-mark: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
