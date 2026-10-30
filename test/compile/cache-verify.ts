// TERM_CACHE_VERIFY (decision 077 section 5, item term-self-host-001-0407). A stored unit answer that a key forgot an
// input of is served as it was stored; under `hits` the build builds every stored answer it reads again and refuses one
// whose bytes differ, naming the unit. The forgotten input is planted here as a stored entry whose emitted text was
// changed after it was written (the same bytes a build would have stored had its key missed what changed them). Under
// `twice` every unit built is built a second time in the process and must answer the same bytes.
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
const store = realpathSync(mkdtempSync(join(tmpdir(), 'cache-verify-store-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/verify\n  mark <0.0.1>\n`)
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

    return statSync(full).isDirectory() ? entries(full) : full.endsWith('.json.gz') ? [full] : []
  })

const emitted = (): string =>
  readdirSync(join(root, 'host', '.unit'))
    .sort()
    .map(name => readFileSync(join(root, 'host', '.unit', name), 'utf8'))
    .join('\n')

// the modes read
ok('off by default', cacheVerifyOf('').twice === false && cacheVerifyOf('').hit('x') === false)
ok('hits is every hit', cacheVerifyOf('hits').hit('a') && cacheVerifyOf('hits:1').hit('b'))
ok('hits:0 is none', !cacheVerifyOf('hits:0').hit('a'))
const half = cacheVerifyOf('hits:0.5')
const chosen = Array.from({ length: 400 }, (_, i) => half.hit(`key-${i}`)).filter(Boolean).length
ok('hits:0.5 chooses about half, the same on every ask', chosen > 150 && chosen < 250 && half.hit('key-7') === half.hit('key-7'), `${chosen}`)
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
ok('an unknown mode is refused', refused.includes('not a verify mode'), refused)

// a clean build under `twice`: every unit built twice, the same bytes, the same output
const first = build('twice')
ok('a build under twice builds', first.failed === 0, first.errors.join(' | '))
const clean = emitted()
ok('and emits the planted name', clean.includes('planted-name'))

// a no-op under `hits` reads every stored answer, builds each again, and finds them equal
const second = build('hits')
ok('a no-op under hits builds nothing and passes', second.failed === 0 && second.built === 0, `${second.built} built | ${second.errors.join(' | ')}`)
ok('to the same output', emitted() === clean)

// plant the forgotten input: the stored answers' emitted name changed after they were written
const units = entries(store).filter(file => relative(store, file).split(sep)[0] === 'unit')
let planted = 0
for (const file of units) {
  const text = gunzipSync(readFileSync(file)).toString('utf8')

  if (text.includes('planted-name')) {
    writeFileSync(file, gzipSync(Buffer.from(text.split('planted-name').join('PLANTED-NAME'))))
    planted++
  }
}
ok('a stored unit answer holds the name to plant', planted > 0, `${units.length} unit entries`)

// without the check the stale answer is served: this is what a key that forgot an input does
const stale = build('')
ok('without the check the planted answer is served', stale.failed === 0 && emitted().includes('PLANTED-NAME'), stale.errors.join(' | '))

// with it the build refuses, naming the unit and the check
const checked = build('hits')
const said = checked.errors.join(' | ')
ok('under hits the planted answer is refused', checked.failed > 0 && said.includes('cache verify hits'), said)
ok('naming the unit', said.includes('base.tree'), said)

rmSync(root, { recursive: true, force: true })
rmSync(store, { recursive: true, force: true })
console.log(`\ncache-verify: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
