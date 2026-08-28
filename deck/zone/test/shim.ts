// The globals that `term boot` prepends, installed by hand.
//
//   import './shim'          FIRST, before any import of ../host/**
//
// A module under ../host/ is emitted assuming the natives it calls are
// already global: `octets`, `cipher`, `bit`, `digest` and a `require`. Under
// `term boot` they are prepended to the bundle. Reaching the same module
// directly from tsx skips that step, and the first native call fails with
// `ReferenceError: octets is not defined` pointing at emitted code rather
// than at the missing setup.
//
// Imported for the side effect. It exports nothing on purpose.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)

;(globalThis as any).require = require_

for (const [file, name] of Object.entries({
  bytes: 'octets',
  cipher: 'cipher',
  bit: 'bit',
  digest: 'digest',
})) {
  let src: string

  try {
    src = readFileSync(
      resolve(HERE, `../../seed/code/native/node/runtime/${file}.ts`),
      'utf8',
    )
  } catch {
    continue
  }

  const js = transformSync(src, { loader: 'ts', format: 'cjs' }).code

  ;(globalThis as any)[name] = new Function(
    'require',
    `${js}; return ${file}`,
  )(require_)
}

Object.defineProperty(globalThis, 'crypto', {
  value: require_('node:crypto'),
  configurable: true,
  writable: true,
})
