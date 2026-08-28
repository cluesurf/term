// Sealing checks, run against the compiled output.
//
//   pnpm exec tsx test/seal.ts        (from the zone package)
//
// These cover the security properties of `code/seal/base.tree`, which the
// Term test DSL cannot reach because sealing is async and needs the native
// runtime. Every check must pass. A failure here means a cache that opens
// under the wrong address, which is the one thing this design exists to
// prevent.
//
// The `<global:...>` runtime shims are prepended by `term boot` rather than
// imported, so they are installed here by hand. That is the whole reason
// this is a script and not a `.tree` test.

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)
;(globalThis as any).require = require_

// The shim file declares one const named after the file. Term docks the
// byte shim under the name `octets`, so the two are mapped here.
const AS: Record<string, string> = { bytes: 'octets', cipher: 'cipher', bit: 'bit' }

for (const [file, global] of Object.entries(AS)) {
  const source = readFileSync(
    resolve(HERE, `../../seed/code/native/node/runtime/${file}.ts`),
    'utf8',
  )
  const js = transformSync(source, { loader: 'ts', format: 'cjs' }).code
  ;(globalThis as any)[global] = new Function(
    'require',
    `${js}; return ${file}`,
  )(require_)
}

// `crypto` is node's own module, docked rather than shimmed.
// `globalThis.crypto` is a getter-only Web Crypto instance on node, and the
// emitted code wants node's `crypto.randomBytes`, so the property is
// redefined rather than assigned.
Object.defineProperty(globalThis, 'crypto', {
  value: require_('node:crypto'),
  configurable: true,
  writable: true,
})

const { makeKey, sealValue, openValue } = await import('../host/code/seal/base')

let bad = 0
const ok = (label: string, pass: boolean) => {
  if (!pass) bad += 1
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${label}`)
}

const key = await makeKey()
const other = await makeKey()
const secret = 'postgres://user:pw@host/db'
const code = await sealValue(key, 'base/word.surf/star', 'database-url', secret)

ok('round trip', (await openValue(key, 'base/word.surf/star', 'database-url', code)) === secret)
ok('sealed value is tone only', /^[mndbtkhsfvzxcwlrMNDBTKHSFVZXCWLR-]+$/.test(code))
ok('no plaintext in the sealed value', !code.includes('postgres'))

const twice = await sealValue(key, 'base/word.surf/star', 'database-url', secret)
ok('a fresh nonce every write', twice !== code)
ok('and both still open', (await openValue(key, 'base/word.surf/star', 'database-url', twice)) === secret)

const refuses = async (label: string, fn: () => Promise<unknown>) => {
  try { await fn(); ok(label, false) } catch { ok(label, true) }
}
await refuses('refuses a different name', () => openValue(key, 'base/word.surf/star', 'sentry-dsn', code))
await refuses('refuses a different zone', () => openValue(key, 'base/word.surf/moon', 'database-url', code))
await refuses('refuses a different key', () => openValue(other, 'base/word.surf/star', 'database-url', code))
// Flip a character in the MIDDLE, never the last one. A tone-packed value
// carries up to four trailing bits that are padding and are dropped on
// unpack, so changing the final character sometimes changes no byte at all
// and the value still opens. That made this check pass or fail by luck.
const at = Math.floor(code.length / 2)
const flipped =
  code.slice(0, at) + (code[at] === 'm' ? 'n' : 'm') + code.slice(at + 1)
await refuses('refuses a tampered value', () => openValue(key, 'base/word.surf/star', 'database-url', flipped))

console.log(`\n  sealed ${secret.length} bytes -> ${code.split('-').join('').length} tone characters`)

console.log(bad ? `\n  ${bad} FAILED` : '\n  every sealing check passed')
process.exit(bad ? 1 : 0)
