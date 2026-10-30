// TERM_CACHE_VERIFY (decision 077 section 5, item term-self-host-001-0407). A stored unit answer that a key forgot an
// input of is served as it was stored; under `hits` the build builds every stored answer it reads again and refuses one
// whose bytes differ, naming the unit. The forgotten input is planted here as a stored entry whose emitted text was
// changed after it was written (the same bytes a build would have stored had its key missed what changed them). Under
// `twice` every unit built is built a second time in the process, after the run's other units, and must answer the same
// bytes. Under `ledger` a read made inside a unit's build that its key does not cover (planted here through the face's
// test hook: a file outside every unit, a setting) fails the build, naming the unit, the reader and what it read.
// Run: npx tsx test/compile/cache-verify.ts

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  buildSession,
  compileProjectSeparate,
} from '@term/call/code/make'
import { diskCacheStore } from '@term/call/code/cache-store'
import { CompileCache } from '@term/make/code/compile/cache'
import { cacheVerifyOf } from '@term/make/code/compile/separate'

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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cache-verify-')))
const store = realpathSync(
  mkdtempSync(join(tmpdir(), 'cache-verify-store-')),
)
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(
  join(root, 'deck.tree'),
  `deck @probe/verify\n  mark <0.0.1>\n`,
)
writeFileSync(
  join(root, 'code', 'helper.tree'),
  `task greet\n  take who, like text\n  like text\n  back <hello {who}>\n`,
)
writeFileSync(
  join(root, 'code', 'base.tree'),
  `load ./helper\n  find greet\n\ntask main\n  like text\n  back greet(<planted-name>)\n`,
)

const build = (verify: string) => {
  process.env.TERM_CACHE_VERIFY = verify

  try {
    return compileProjectSeparate(
      root,
      new CompileCache(diskCacheStore(store, 'verify'), 'verify'),
      'node',
      buildSession(root),
    )
  } finally {
    delete process.env.TERM_CACHE_VERIFY
  }
}

const entries = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const full = join(dir, name)

    return statSync(full).isDirectory()
      ? entries(full)
      : full.endsWith('.json.gz')
        ? [full]
        : []
  })

const emitted = (): string =>
  readdirSync(join(root, 'host', '.unit'))
    .sort()
    .map(name =>
      readFileSync(join(root, 'host', '.unit', name), 'utf8'),
    )
    .join('\n')

// the modes read
ok(
  'off by default',
  cacheVerifyOf('').twice === false &&
    cacheVerifyOf('').hit('x') === false,
)
ok(
  'hits is every hit',
  cacheVerifyOf('hits').hit('a') && cacheVerifyOf('hits:1').hit('b'),
)
ok('hits:0 is none', !cacheVerifyOf('hits:0').hit('a'))
const half = cacheVerifyOf('hits:0.5')
const chosen = Array.from({ length: 400 }, (_, i) =>
  half.hit(`key-${i}`),
).filter(Boolean).length
ok(
  'hits:0.5 chooses about half, the same on every ask',
  chosen > 150 &&
    chosen < 250 &&
    half.hit('key-7') === half.hit('key-7'),
  `${chosen}`,
)
ok('twice', cacheVerifyOf('twice,hits').twice)
let refused = ''
try {
  cacheVerifyOf('hits:2')
} catch (problem) {
  refused = String(problem)
}
ok('a share past 1 is refused', refused.includes('share'), refused)
refused = ''
try {
  cacheVerifyOf('everything')
} catch (problem) {
  refused = String(problem)
}
ok(
  'an unknown mode is refused',
  refused.includes('not a verify mode'),
  refused,
)

// a clean build under `twice`: every unit built twice, the same bytes, the same output
const first = build('twice')
ok(
  'a build under twice builds',
  first.failed === 0,
  first.errors.join(' | '),
)
const clean = emitted()
ok('and emits the planted name', clean.includes('planted-name'))

// a no-op under `hits` reads every stored answer, builds each again, and finds them equal
const second = build('hits')
ok(
  'a no-op under hits builds nothing and passes',
  second.failed === 0 && second.built === 0,
  `${second.built} built | ${second.errors.join(' | ')}`,
)
ok('to the same output', emitted() === clean)

// plant the forgotten input: the stored answers' emitted name changed after they were written
const units = entries(store).filter(
  file => relative(store, file).split(sep)[0] === 'unit',
)
let planted = 0
for (const file of units) {
  const text = gunzipSync(readFileSync(file)).toString('utf8')

  if (text.includes('planted-name')) {
    writeFileSync(
      file,
      gzipSync(
        Buffer.from(text.split('planted-name').join('PLANTED-NAME')),
      ),
    )
    planted++
  }
}
ok(
  'a stored unit answer holds the name to plant',
  planted > 0,
  `${units.length} unit entries`,
)

// without the check the stale answer is served: this is what a key that forgot an input does
const stale = build('')
ok(
  'without the check the planted answer is served',
  stale.failed === 0 && emitted().includes('PLANTED-NAME'),
  stale.errors.join(' | '),
)

// with it the build stops, naming the check, the unit and the place the two answers part
let said = ''
try {
  const checked = build('hits')
  said = `no raise: ${checked.failed} failed, ${checked.errors.join(' | ')}`
} catch (problem) {
  said = String((problem as { note?: string }).note ?? problem)
}
ok(
  'under hits the planted answer is refused',
  said.startsWith('cache verify hits'),
  said.slice(0, 300),
)
ok(
  'naming the unit',
  said.includes('/code/base.tree answered differently'),
  said.slice(0, 300),
)
ok(
  'and showing both answers where they part',
  said.includes('PLANTED-NAME') &&
    said.includes('against') &&
    said.includes('planted-name'),
  said.slice(0, 300),
)

// `ledger`: a clean build on an empty store makes no read its keys do not cover
const ledgerStore = realpathSync(
  mkdtempSync(join(tmpdir(), 'cache-verify-ledger-')),
)
const ledgerBuild = (verify: string) => {
  process.env.TERM_CACHE_VERIFY = verify

  try {
    return compileProjectSeparate(
      root,
      new CompileCache(
        diskCacheStore(
          mkdtempSync(join(ledgerStore, 'store-')),
          'verify',
        ),
        'verify',
      ),
      'node',
      buildSession(root),
    )
  } finally {
    delete process.env.TERM_CACHE_VERIFY
  }
}
ok(
  'ledger is a mode',
  cacheVerifyOf('ledger,hits').ledger && !cacheVerifyOf('hits').ledger,
)
let ledgeredSaid = ''
try {
  const ledgered = ledgerBuild('ledger,twice')
  ledgeredSaid = `${ledgered.failed} failed ${ledgered.errors.join(' | ')}`
} catch (problem) {
  ledgeredSaid = String((problem as { note?: string }).note ?? problem)
}
ok(
  'a clean build under ledger reads only what its keys cover',
  ledgeredSaid.startsWith('0 failed'),
  ledgeredSaid.slice(0, 300),
)

// a read no key holds, planted inside a unit's build: a file outside every unit, and then a setting
const outside = join(ledgerStore, 'outside.txt')
writeFileSync(outside, 'not a module\n')
const plant = globalThis as {
  termLedgerPlant?: (files: string[]) => void
}
const plantedSaid = (read: (files: string[]) => void): string => {
  plant.termLedgerPlant = read

  try {
    const checked = ledgerBuild('ledger')
    return `no raise: ${checked.failed} failed, ${checked.errors.join(' | ')}`
  } catch (problem) {
    return String((problem as { note?: string }).note ?? problem)
  } finally {
    delete plant.termLedgerPlant
  }
}
const fileSaid = plantedSaid(() => readFileSync(outside, 'utf8'))
ok(
  'a planted file read is refused under ledger',
  fileSaid.startsWith('cache verify ledger'),
  fileSaid.slice(0, 300),
)
ok(
  'naming the unit, the reader and the path',
  fileSaid.includes('unit ') && fileSaid.includes(`read ${outside}`),
  fileSaid.slice(fileSaid.indexOf('made a read'), 400),
)
const envSaid = plantedSaid(() => void process.env.TERM_PLANTED_SETTING)
ok(
  'a planted setting read is refused under ledger',
  envSaid.includes('env TERM_PLANTED_SETTING'),
  envSaid.slice(0, 300),
)
// only the entry's unit reaches helper.tree, so only its build reads it
const ownSaid = plantedSaid(files => {
  if (files.some(file => file.endsWith(join('code', 'base.tree'))))
    readFileSync(join(root, 'code', 'helper.tree'), 'utf8')
})
ok(
  "a read of a module the unit reaches, with the walk's bytes, is covered",
  !ownSaid.startsWith('cache verify'),
  ownSaid.slice(0, 300),
)
const offSaid = (() => {
  plant.termLedgerPlant = () => readFileSync(outside, 'utf8')

  try {
    const checked = ledgerBuild('')
    return `${checked.failed} failed`
  } finally {
    delete plant.termLedgerPlant
  }
})()
ok(
  'without ledger the planted read is not looked at',
  offSaid === '0 failed',
  offSaid,
)

rmSync(ledgerStore, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })
rmSync(store, { recursive: true, force: true })
console.log(`\ncache-verify: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
