// A DOCK ALIAS REACHED THROUGH `find` IS STILL A HOST VALUE (item term-self-host-001-1087, trap T-1067). A shared module
// that docked `<global:shape>` itself had `host actual-type, like text` over `shape/type-of(...)` checked at the
// binding: `__termHost(...)` on TypeScript, a downcast raising `data-mismatch` on Rust, Swift and Kotlin. Moved into a
// module of its own and reached as `load ... / find shape`, the same line compiled to a bare call, because the checker
// typed a dock alias as the host's own value (`dynamic`) only in the file that docked it. Every output still read the
// same, since the shim answers a text, so only the emitted body showed it.
//
// Each program is compiled twice, the dock in the file and the dock in a module the file loads, and both must emit the
// check and raise the same `data-mismatch` on every backend whose toolchain is here.
// Run: npx tsx test/compile/found-dock-host.ts

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKENDS, runOn } from './shared/run-on'
import { projectResolver } from '@term/call/code/make'

const ROOT = join(import.meta.dirname, '..', '..')

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

const DOCK = `dock load
  load <global:shape>, name shape
`

// a text the host answers, held as a text (passes) and as a number (raises at the binding)
const BODY = `task run
  like text
  host kind, like text
    call shape/type-of
      bind value, text <a>
  save answer, <none>
  fork
    mark unsafe
    host count, like number
      call shape/type-of
        bind value, text <a>
    save answer, <{count}>
  halt take
    take problem
    save answer, <{problem/form}: {problem/note}>
  back <{kind} {answer}>
`

const FOUND = `load ./helper
  find shape

${BODY}`

const INLINE = `${DOCK}
${BODY}`

const RAISED = ' data-mismatch: Data does not fit the shape'

// inside the root: a relative load must stay within the package and project roots, so the system temp folder answers
// nothing for `load ./helper`
mkdirSync(join(ROOT, 'tmp'), { recursive: true })
const dir = mkdtempSync(join(ROOT, 'tmp', 'found-dock-host-'))
writeFileSync(
  join(dir, 'helper.tree'),
  `# the dock alone, as native/<platform>/shape.tree holds it\n\n${DOCK}`,
)

const resolve = (env: Parameters<typeof projectResolver>[1]) =>
  projectResolver(ROOT, env, ROOT)

for (const [name, program] of [
  ['inline', INLINE],
  ['found', FOUND],
] as const) {
  runOn({
    backend: 'typescript',
    program,
    resolve,
    dir,
    name,
  })

  let emitted = ''

  try {
    emitted = readFileSync(join(dir, `${name}-typescript.ts`), 'utf8')
  } catch {
    emitted = '(no emit)'
  }

  ok(
    `${name}: the text binding is checked on TypeScript`,
    emitted.includes(
      '__termHost(shape.typeOf("a"), "string", "kind")',
    ),
    emitted.slice(0, 400),
  )
  ok(
    `${name}: the number binding is checked on TypeScript`,
    emitted.includes(
      '__termHost(shape.typeOf("a"), "number", "count")',
    ),
    emitted.slice(0, 400),
  )
}

for (const backend of BACKENDS) {
  const said: Record<string, string> = {}

  for (const [name, program] of [
    ['inline', INLINE],
    ['found', FOUND],
  ] as const) {
    const done = runOn({
      backend,
      program,
      resolve,
      dir,
      name: `${name}-run`,
    })

    said[name] =
      done.form === 'ran'
        ? done.output
        : done.form === 'skipped'
          ? 'skipped'
          : `${done.form}: ${done.reason.slice(0, 400)}`
  }

  if (said.inline === 'skipped') {
    console.log(`skip  ${backend}: toolchain not installed`)
    continue
  }

  ok(
    `${backend}: the docked file raises data-mismatch at the number binding`,
    (said.inline ?? '').endsWith(RAISED),
    said.inline,
  )
  ok(
    `${backend}: the file that finds the dock prints the same`,
    said.found === said.inline,
    `found ${said.found} | inline ${said.inline}`,
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
