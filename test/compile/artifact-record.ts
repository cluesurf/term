// A LOST ARTIFACT RECORD COSTS A FULL SWEEP, NEVER A STALE ARTIFACT (item term-self-host-001-0433, decision 077 section
// 4). Each separate build records what it wrote under host/ at <project>/.base/@term/code/artifacts.txt, the project's
// root on its first line, and removes what the last build recorded and this one does not stand behind (item 0425). A
// record that is missing or another root's is lost: the build then removes every .ts file under host/.unit and the host/
// folders it writes into that it does not stand behind. Held on both twins: the engine (call/code/make.ts
// `sweepArtifacts`, the session's path) and the CLI (work/build/separate-build.tree `sweep-artifacts`).
// Run: npx tsx test/compile/artifact-record.ts

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildSession,
  compileProjectSeparate,
  sweepArtifacts,
} from '@term/call/code/make'
import { diskCacheStore } from '@term/call/code/cache-store'
import { CompileCache } from '@term/make/code/compile/cache'

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

const TERM = realpathSync(join(import.meta.dirname, '..', '..'))
const scratch = realpathSync(
  mkdtempSync(join(tmpdir(), 'artifact-record-')),
)

const project = (name: string): string => {
  const root = join(scratch, name)
  mkdirSync(join(root, 'code'), { recursive: true })
  writeFileSync(
    join(root, 'deck.tree'),
    `deck @probe/record\n  mark <0.0.1>\n`,
  )
  writeFileSync(
    join(root, 'code', 'base.tree'),
    `task main\n  like number\n  send back, code 1\n`,
  )
  return root
}

const twins: [string, (root: string) => void][] = [
  [
    'engine',
    root => {
      compileProjectSeparate(
        root,
        new CompileCache(
          diskCacheStore(join(scratch, 'store-engine'), 'record'),
          'record',
        ),
        'node',
        buildSession(root),
      )
    },
  ],
  [
    'cli',
    root => {
      spawnSync(
        process.execPath,
        [join(TERM, 'host', 'line.js'), 'make', '--all'],
        {
          cwd: root,
          env: {
            ...process.env,
            TERM_CACHE_HOME: join(scratch, 'store-cli'),
            TERM_STDLIB: join(TERM, 'deck', 'base'),
          },
          encoding: 'utf8',
        },
      )
    },
  ],
]

for (const [twin, build] of twins) {
  const root = project(twin)
  const record = join(root, '.base', '@term', 'code', 'artifacts.txt')
  const extra = join(root, 'code', 'extra.tree')
  const shim = join(root, 'host', 'code', 'extra.ts')
  const unit = join(
    root,
    'host',
    '.unit',
    '_probe_record_code_extra.ts',
  )
  const add = (): void =>
    writeFileSync(
      extra,
      `task extra\n  like number\n  send back, code 2\n`,
    )
  const shelve = (): void =>
    writeFileSync(
      extra,
      `mark draft\ntask extra\n  like number\n  send back, code 2\n`,
    )

  build(root)
  const first = existsSync(record) ? readFileSync(record, 'utf8') : ''
  ok(
    `${twin}: the record names the project's root first`,
    first.startsWith(`# term artifacts ${root}\n`),
    first.slice(0, 120),
  )

  add()
  build(root)
  ok(
    `${twin}: an added module's artifacts are written`,
    existsSync(shim) && existsSync(unit),
    `${existsSync(shim)} ${existsSync(unit)}`,
  )

  // the record removed, then the module shelved: nothing recorded says the shelved module's artifacts were written
  rmSync(record, { force: true })
  shelve()
  build(root)
  ok(
    `${twin}: a missing record sweeps the shelved module's artifacts`,
    !existsSync(shim) && !existsSync(unit),
    `${existsSync(shim)} ${existsSync(unit)}`,
  )
  ok(
    `${twin}: and keeps what the build stands behind`,
    existsSync(join(root, 'host', 'code', 'base.ts')),
  )
  ok(
    `${twin}: and host/'s own files`,
    existsSync(join(root, 'host', 'roll.json')) === (twin === 'cli'),
  )

  add()
  build(root)
  // another root's record (a copied project): it names nothing of this one's
  writeFileSync(
    record,
    `# term artifacts /another/root\nhost/code/base.ts\n`,
  )
  shelve()
  build(root)
  ok(
    `${twin}: another root's record sweeps them too`,
    !existsSync(shim) && !existsSync(unit),
    `${existsSync(shim)} ${existsSync(unit)}`,
  )
  ok(
    `${twin}: and is written again as this root's`,
    readFileSync(record, 'utf8').startsWith(
      `# term artifacts ${root}\n`,
    ),
  )
}

// THE RECORD IS WRITTEN WHOLE OR NOT AT ALL, AND ITS WRITE NEVER FAILS THE BUILD (item term-self-host-001-0470). A write
// of the record straight over the live file can be read, or cut off, after its header: a short list under a valid
// header, so the next build sweeps only what that list names and leaves a shelved module's artifacts behind for good.
// The cut is made here by a patched writeFileSync (the in-process twin by this process's own patch, the CLI by the same
// patch through --import): a write to the record or its temp writes the header line alone and raises ENOSPC, as a full
// disk would. And a record that cannot be written at all (a folder stands at its path): the build goes on
const CUT = 'ARTIFACT_RECORD_CUT'
const patch = join(scratch, 'record-cut.mjs')
writeFileSync(
  patch,
  `import * as fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'

const cjs = createRequire(import.meta.url)('node:fs')
const original = cjs.writeFileSync
cjs.writeFileSync = function (file, data, ...rest) {
  if (process.env.${CUT} === '1' && String(file).includes('artifacts.txt')) {
    const text = String(data)
    original.call(this, file, text.slice(0, text.indexOf('\\n') + 1))
    const problem = new Error('ENOSPC: no space left on device, write')
    problem.code = 'ENOSPC'
    throw problem
  }
  return original.call(this, file, data, ...rest)
}
syncBuiltinESMExports()
`,
)
await import(patch)

const cutTwins: [string, (root: string) => boolean][] = [
  [
    'engine',
    root => {
      try {
        twins[0]![1](root)
        return true
      } catch {
        return false
      }
    },
  ],
  [
    'cli',
    root =>
      spawnSync(
        process.execPath,
        ['--import', patch, join(TERM, 'host', 'line.js'), 'make', '--all'],
        {
          cwd: root,
          env: {
            ...process.env,
            TERM_CACHE_HOME: join(scratch, 'store-cli'),
            TERM_STDLIB: join(TERM, 'deck', 'base'),
          },
          encoding: 'utf8',
        },
      ).status === 0,
  ],
]

const tempsBeside = (record: string): string[] =>
  existsSync(dirname(record))
    ? readdirSync(dirname(record)).filter(name =>
        name.startsWith('artifacts.txt.'),
      )
    : []

for (const [twin, build] of cutTwins) {
  const root = project(`cut-${twin}`)
  const record = join(root, '.base', '@term', 'code', 'artifacts.txt')
  const extra = join(root, 'code', 'extra.tree')
  const shim = join(root, 'host', 'code', 'extra.ts')
  const unit = join(root, 'host', '.unit', '_probe_record_code_extra.ts')
  writeFileSync(extra, `task extra\n  like number\n  send back, code 2\n`)
  build(root)
  const whole = existsSync(record) ? readFileSync(record, 'utf8') : ''
  ok(
    `${twin}: the record names the added module`,
    whole.includes(`host/code/extra.ts`),
    whole.slice(0, 200),
  )

  // a module added, so the record is written again, and that write cut after its header
  writeFileSync(
    join(root, 'code', 'more.tree'),
    `task more\n  like number\n  send back, code 3\n`,
  )
  process.env[CUT] = '1'
  const built = build(root)
  delete process.env[CUT]
  ok(`${twin}: a record write cut short does not fail the build`, built)
  const after = existsSync(record) ? readFileSync(record, 'utf8') : ''
  ok(
    `${twin}: and the record is still the last whole one`,
    after === whole,
    JSON.stringify(after.slice(0, 200)),
  )
  ok(
    `${twin}: and no temp is left beside it`,
    tempsBeside(record).length === 0,
    tempsBeside(record).join(' '),
  )

  // the module shelved: the record read must name it, so its artifacts go
  writeFileSync(
    extra,
    `mark draft\ntask extra\n  like number\n  send back, code 2\n`,
  )
  build(root)
  ok(
    `${twin}: a shelved module's artifacts go after a cut write`,
    !existsSync(shim) && !existsSync(unit),
    `${existsSync(shim)} ${existsSync(unit)}`,
  )

  // a record that cannot be written at all: a folder stands at its path
  rmSync(record, { force: true })
  mkdirSync(record, { recursive: true })
  writeFileSync(
    join(root, 'code', 'last.tree'),
    `task last\n  like number\n  send back, code 4\n`,
  )
  ok(
    `${twin}: a record that cannot be written does not fail the build`,
    build(root),
  )
  ok(
    `${twin}: and the build's artifacts are written`,
    existsSync(join(root, 'host', 'code', 'last.ts')),
  )
  ok(
    `${twin}: and no temp is left beside the record`,
    tempsBeside(record).length === 0,
    tempsBeside(record).join(' '),
  )
}

// the TypeScript twin, called directly: no build reaches it since item 0412 (make.ts builds through build-graph.tree)
{
  const root = join(scratch, 'direct')
  const record = join(root, '.base', '@term', 'code', 'artifacts.txt')
  const a = join(root, 'host', 'code', 'a.ts')
  const b = join(root, 'host', 'code', 'b.ts')
  const c = join(root, 'host', 'code', 'c.ts')
  mkdirSync(join(root, 'host', 'code'), { recursive: true })

  for (const one of [a, b, c]) writeFileSync(one, '')

  sweepArtifacts(root, new Set([a, b]))
  const whole = readFileSync(record, 'utf8')
  process.env[CUT] = '1'
  let swept = true

  try {
    sweepArtifacts(root, new Set([a, b, c]))
  } catch {
    swept = false
  }

  delete process.env[CUT]
  ok(`typescript: a record write cut short does not raise`, swept)
  ok(
    `typescript: and the record is still the last whole one`,
    readFileSync(record, 'utf8') === whole,
  )
  sweepArtifacts(root, new Set([a]))
  ok(`typescript: what the whole record names goes after a cut write`, !existsSync(b))
  rmSync(record, { force: true })
  mkdirSync(record)
  let unwritten = true

  try {
    sweepArtifacts(root, new Set([a]))
  } catch {
    unwritten = false
  }

  ok(`typescript: a record that cannot be written does not raise`, unwritten)
  ok(
    `typescript: and no temp is left beside it`,
    tempsBeside(record).length === 0,
    tempsBeside(record).join(' '),
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nartifact-record: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
