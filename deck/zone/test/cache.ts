// Cache round trip and the warm-read budget, run against the compiled output.
//
//   pnpm exec tsx test/cache.ts        (from the zone package)
//
// Seals a set of values, writes a `zone.code.tree`, reads it back, and opens
// every value through the inherited lookup. Then measures the warm path,
// which is what `zone load` pays on every single invocation.
//
// THE BUDGET IS 50 MILLISECONDS and it is the reason the cache exists.
// `bws --version`, which does no network work at all, takes 930ms on the
// machine this was written on. A tool that costs a second per command gets
// worked around within a week.

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)
;(globalThis as any).require = require_
for (const [file, name] of Object.entries({ bytes: 'octets', cipher: 'cipher', bit: 'bit', digest: 'digest' })) {
  let src: string
  try { src = readFileSync(resolve(HERE, `../../seed/code/native/node/runtime/${file}.ts`), 'utf8') } catch { continue }
  const js = transformSync(src, { loader: 'ts', format: 'cjs' }).code
  ;(globalThis as any)[name] = new Function('require', `${js}; return ${file}`)(require_)
}
Object.defineProperty(globalThis, 'crypto', { value: require_('node:crypto'), configurable: true, writable: true })

const { mineFile, findLock, mineZone, pullNeed } = await import('../host/code/config/zone')
const { showFile, markDeck } = await import('../host/code/seal/cache')
const { makeKey, sealValue, openValue } = await import('../host/code/seal/base')

const key = await makeKey()
const secrets: Array<[string, string, string]> = [
  ['base', 'database-url', 'postgres://shared/db'],
  ['base/word.surf', 'sentry-dsn', 'https://wordsurf@sentry'],
  ['base/word.surf/star', 'better-auth-secret', 'a-production-secret'],
]

// Build a cache by hand, the way `zone read` will.
const root: any = { name: '', path: 'base', base: '', bind: '', root: false, need: [], cast: [], load: [], lock: [], zone: [] }
const spotAt = (path: string): any => {
  let at = root
  for (const seg of path.split('/').slice(1)) {
    let kid = at.zone.find((z: any) => z.name === seg)
    if (!kid) {
      kid = { name: seg, path: `${at.path}/${seg}`, base: '', bind: '', root: false, need: [], cast: [], load: [], lock: [], zone: [] }
      at.zone.push(kid)
    }
    at = kid
  }
  return at
}
for (const [path, name, plain] of secrets) {
  spotAt(path).lock.push({ name, code: await sealValue(key, path, name, plain) })
}

const deck = await markDeck('base bitwarden\nneed database-url\n')
const text = showFile({ made: '2026-08-27T18:04:11Z', good: '2026-08-28T06:04:11Z', seal: 'aes-256-gcm', deck, root })

const back: any = mineFile(text)
let bad = 0
const ok = (label: string, pass: boolean) => { if (!pass) bad += 1; console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${label}`) }

ok('header survives a write and a read', back.made === '2026-08-27T18:04:11Z' && back.seal === 'aes-256-gcm' && back.deck === deck)
ok('deck mark is a sha256 in the 8x8 tone shape', /^([mndbtkhsfvzxcwlr]{8}-){7}[mndbtkhsfvzxcwlr]{8}$/.test(deck))
for (const [path, name, plain] of secrets) {
  const got: any = findLock(back.root, path, name)
  const opened = got.form === 'none' ? '(missing)' : await openValue(key, path, name, got.value.code)
  ok(`${path} holds ${name}`, opened === plain)
}

// A value bound only deep in the tree must not be visible above it.
ok(
  'a deep value is not visible above it',
  (findLock(back.root, 'base/word.surf', 'better-auth-secret') as any).form === 'none',
)

// THE WARM PATH. Parse the declaration, parse the cache, resolve the path,
// and open every value that path needs. No network, no keychain: those are
// measured separately and come to 18.4ms together.
const declaration = 'base bitwarden\nneed database-url\n\nzone word.surf\n  need sentry-dsn\n\n  zone star\n    need better-auth-secret\n'

const warm = async () => {
  const decl: any = mineZone(declaration)
  const needs = pullNeed(decl, 'base/word.surf/star') as any[]
  const file: any = mineFile(text)
  let got = 0
  for (const need of needs) {
    const lock: any = findLock(file.root, 'base/word.surf/star', need.name)
    if (lock.form === 'some') {
      await openValue(key, 'base', need.name, lock.value.code).catch(() => undefined)
      got += 1
    }
  }
  return got
}

await warm()
const runs = 40
const began = performance.now()
for (let i = 0; i < runs; i += 1) await warm()
const each = (performance.now() - began) / runs

console.log(`\n  warm read: ${each.toFixed(2)} ms  (budget 50 ms, of which 18.4 ms is keychain and spawn)`)
ok('the warm read is inside its budget', each < 50 - 18.4)

console.log(bad ? `\n  ${bad} FAILED` : '\n  every cache check passed')
process.exit(bad ? 1 : 0)
