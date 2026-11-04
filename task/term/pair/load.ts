// How a port's emitted module is loaded: the native shims it assumes are global, installed first.
//
// MOVED here from task/term/self-host.ts (item term-self-host-001-0011), which now imports it, so there is one
// version. A module emitted under `host/**` assumes the natives it calls are already global, because `term boot`
// PREPENDS them to the bundle. Importing one directly skips that, and the first native call dies with
// `ReferenceError: bit is not defined` pointing at emitted code rather than at the missing setup. A shim is
// CONCATENATED and not imported -- it declares `const bit = {...}` at top level -- so it is evaluated here the way
// deck/zone/test/shim.ts does it.
//
// A pair module (tmp/self-host/pairs/<name>.ts) that reads a port calls
// `installShims(['bit', 'regex'])` before it imports the port, exactly as self-host.ts does.
//
// Run from the Term root, the way every other term task is.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { transformSync } from 'esbuild'

export function installShims(names: string[]): void {
  const term = process.cwd()
  const require_ = createRequire(join(term, 'x.js'))

  for (const name of names) {
    const file = join(term, 'deck/base/code/native/node/runtime', `${name}.ts`)

    try {
      const js = transformSync(readFileSync(file, 'utf8'), {
        loader: 'ts',
        format: 'cjs',
      }).code
      const make = new Function(
        'require',
        'module',
        'exports',
        `${js}; return typeof ${name} !== 'undefined' ? ${name} : undefined`,
      ) as (r: unknown, m: unknown, e: unknown) => unknown

      ;(globalThis as Record<string, unknown>)[name] = make(
        require_,
        { exports: {} },
        {},
      )
    } catch (cause) {
      console.log(`  could not install the ${name} shim: ${String(cause)}`)
    }
  }
}
