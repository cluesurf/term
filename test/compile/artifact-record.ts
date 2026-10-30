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
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSession,
  compileProjectSeparate,
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

rmSync(scratch, { recursive: true, force: true })
console.log(`\nartifact-record: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
