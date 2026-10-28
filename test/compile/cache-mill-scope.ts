// A MILL CHANGE REBUILDS THE OUTPUT (item term-self-host-001-0343). The output kind's version must move whenever the
// mill kind's does, or an output entry built by the old mill is served. compile.ts reaches the mill only through
// ports: unit-mill.tree docks compile/mill.ts, and minting.tree docks the baked code-role grammar
// (compile/mill-grammar.generated.ts), so the scope walk must follow an emitted port's dock imports.
//
// For each mill file below, the test touches it (its mtime only, restored after; the version is a stat of each scoped
// file), asks a fresh process for every kind's version, and checks that mill and output both moved. Then it builds a
// program under the old versions twice (a miss, then a hit) and once under the new ones, which must miss output and
// answer the same.
//
// Run: npx tsx test/compile/cache-mill-scope.ts

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { CompileCache } from '@term/make/code/compile/cache'
import { compilerVersions, sharedCacheStore } from '@term/call/code/cache-store'
import { CACHE_SCOPE } from '@term/make/code/compile/cache-scope.generated'

if (process.argv.includes('--versions')) {
  process.stdout.write(JSON.stringify(compilerVersions()))
  process.exit(0)
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

const TERM = process.cwd()

// mill files a compile reaches only through a port's dock: the grammar text, the mill face, the mill engine's port
const MILL_FILES = [
  'deck/make/code/compile/mill-grammar.generated.ts',
  'deck/make/code/compile/mill.ts',
  'deck/make/code/compile/mill-run.ts',
  'deck/make/host/port/code/compile/mill-running.ts',
]

function versionsNow(): Record<string, string> {
  const run = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, '--versions'], {
    cwd: TERM,
    encoding: 'utf8',
  })

  if (run.status !== 0) {
    throw new Error(`versions child failed: ${run.stderr}`)
  }

  return JSON.parse(run.stdout) as Record<string, string>
}

const output = new Set(CACHE_SCOPE['output'] ?? [])
const escaped = (CACHE_SCOPE['mill'] ?? []).filter(file => !output.has(file))
ok('every mill-scope file is in the output scope', escaped.length === 0, escaped.join(', '))

for (const file of MILL_FILES) {
  ok(`${file} is in the mill scope`, (CACHE_SCOPE['mill'] ?? []).includes(file))
}

const SOURCE = `
task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2
`

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'term-cache-mill-scope-'))
const main = path.join(work, 'main.tree')
fs.writeFileSync(main, SOURCE)
const local = path.join(work, 'local')
const shared = path.join(work, 'shared')
fs.mkdirSync(local, { recursive: true })
fs.mkdirSync(shared, { recursive: true })

function build(versions: Record<string, string>): { cache: CompileCache; ok: boolean; text: string } {
  const forKind = (kind: string): string => versions[kind] ?? ''
  const cache = new CompileCache(sharedCacheStore(local, shared, forKind), forKind)
  const result = compile({ file: main, text: SOURCE }, { cache })

  return { cache, ok: result.ok, text: result.ok ? result.typescript : '' }
}

const mtimes = new Map(MILL_FILES.map(file => [file, Math.floor(fs.statSync(path.join(TERM, file)).mtimeMs)]))
const before = versionsNow()
const first = build(before)
ok('the program compiles', first.ok)
const again = build(before)
ok('an unchanged compiler hits', again.cache.misses === 0 && again.cache.hits + again.cache.diskHits > 0,
  `${again.cache.misses} misses`)

try {
  for (const file of MILL_FILES) {
    const full = path.join(TERM, file)
    const stat = fs.statSync(full)
    const was = before

    try {
      // one second past the latest of now and the old mtime, so the stat must differ
      const at = new Date(Math.max(Date.now(), stat.mtimeMs) + 1000)
      fs.utimesSync(full, stat.atime, at)
      const now = versionsNow()

      ok(`touching ${file} moves the mill version`, now['mill'] !== was['mill'])
      ok(`touching ${file} moves the output version`, now['output'] !== was['output'])

      const rebuilt = build(now)
      ok(`touching ${file} rebuilds the output`, rebuilt.cache.misses > 0, `${rebuilt.cache.misses} misses`)
      ok(`touching ${file} builds the same answer`, rebuilt.text === first.text)
    } finally {
      fs.utimesSync(full, stat.atime, stat.mtime)
    }
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}

// the files themselves, not the versions: another session's edit to any scoped file moves a version too
const moved = MILL_FILES.filter(file => Math.floor(fs.statSync(path.join(TERM, file)).mtimeMs) !== mtimes.get(file))
ok('every touched mtime is restored', moved.length === 0, moved.join(', '))

console.log(`\ncache-mill-scope: ${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exitCode = 1
}
