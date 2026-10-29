// `inspect` and `print` of @term/base/debug on TypeScript, Rust, Swift and Kotlin (term/base-v1 decision 001,
// note/project/term/base-v1/decision/001-inspect-prints-term-construction.md). One program inspects a value of every
// kind (a text with every escape, integers, decimals with NaN, a flag, void, lists, a hash, a record with a private
// field and a nested record, a case with fields and one without, a `mark text` case, maybe, a generic form, a recursive
// form, a closure, an unknown, a dock handle), and its standard output is the same bytes on all four and equal to
// inspect-native/values.golden. A caught exception prints as its form and note with its flow; `print` writes to
// standard error and nothing to standard output; a type parameter is refused as `inspect-generic`.
//
// The flow's frames are Term frames (term/hive decision 001), `<task> <file>:<line>`, compared whole: the same on all four.
// Run: npx tsx test/compile/inspect-native.ts   (INSPECT_ONLY=typescript, rust, swift or kotlin runs one)

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { BACKENDS, buildOn } from './shared/run-on'

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

const HERE = join(
  dirname(fileURLToPath(import.meta.url)),
  'inspect-native',
)
const read = (name: string): string =>
  readFileSync(join(HERE, name), 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'term-inspect-native-'))
const only = process.env.INSPECT_ONLY ?? ''
const golden = read('values.golden')
const outputs = new Map<string, string>()

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const resolve = (env: Parameters<typeof projectResolver>[1]) =>
    projectResolver(process.cwd(), env)
  const values = buildOn({
    backend,
    program: read('values.tree'),
    resolve,
    dir,
    name: 'values',
  })

  if (values.form === 'skipped') {
    console.log(`skip  ${backend}: ${values.reason}`)
    continue
  }

  if (values.form === 'failed') {
    ok(
      `${backend}: the values program builds`,
      false,
      `${values.stage}: ${values.reason}`,
    )
    continue
  }

  const ran = spawnSync(values.command[0]!, values.command.slice(1), {
    encoding: 'utf8',
  })
  outputs.set(backend, String(ran.stdout))
  ok(
    `${backend}: every kind prints as the golden says`,
    ran.status === 0 && ran.stdout === golden,
    ran.status === 0
      ? diff(String(ran.stdout), golden)
      : String(ran.stderr).slice(0, 600),
  )

  // one path on every backend, since a frame names its file
  const own = join(dir, backend)
  mkdirSync(own, { recursive: true })
  const raised = buildOn({
    backend,
    program: read('raise.tree'),
    resolve,
    dir: own,
    name: 'raise',
    file: join(own, 'raise.tree'),
  })

  if (raised.form !== 'built') {
    ok(
      `${backend}: the raise program builds`,
      false,
      raised.form === 'failed'
        ? `${raised.stage}: ${raised.reason}`
        : raised.reason,
    )
    continue
  }

  // the flow is Term frames, the same on every backend (term/hive decision 001): the raise, then the guarded call
  const caught = spawnSync(
    raised.command[0]!,
    raised.command.slice(1),
    { encoding: 'utf8' },
  )
  const out = String(caught.stdout)
  const want =
    'absence(note <Not found>, flow list(<fails raise.tree:15>, <run raise.tree:24>))'
  ok(
    `${backend}: a caught exception prints as its form, its note and its Term frames`,
    caught.status === 0 && out === want,
    out.slice(0, 300),
  )

  ok(
    `${backend}: print writes to standard error alone`,
    String(caught.stderr).trim() === 'place(city <Oslo>)' &&
      !out.includes('place('),
    JSON.stringify(String(caught.stderr).slice(0, 200)),
  )
}

const seen = [...outputs.values()]
ok(
  'the values print the same bytes on every backend run',
  seen.length > 0 && seen.every(one => one === seen[0]),
  [...outputs.keys()].join(', '),
)

// a type parameter is refused where it is inspected, naming it
const generic = compile(
  { file: join(dir, 'generic.tree'), text: read('generic.tree') },
  { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
)
const refused = generic.ok
  ? undefined
  : generic.diagnostics.find(d => d.name === 'inspect-generic')
ok(
  'inspect of a type parameter is refused as inspect-generic, naming it',
  refused !== undefined &&
    refused.message.includes('`t` is a type parameter'),
  generic.ok
    ? 'built'
    : generic.diagnostics
        .map(d => `${d.name}: ${d.message}`)
        .join(' | '),
)

// the first line where the two disagree
function diff(got: string, want: string): string {
  const a = got.split('\n')
  const b = want.split('\n')

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}: got ${JSON.stringify(a[i])}, want ${JSON.stringify(b[i])}`
    }
  }

  return ''
}

console.log(`\ninspect-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
