// Shared cache test (Tier 5). The per-module `mill` level lives in a machine-wide shared dir, so two different
// projects that compile the same module (e.g. a linked stdlib file with a shared realpath) reuse each other's mill
// work. The whole-graph `output` level stays project-local. Run: npx tsx test/compile/shared-cache.ts

import { compile } from '@/code/compile/compile'
import { CompileCache } from '@/code/compile/cache'
import { sharedCacheStore } from '@/code/call/cache-store'
import type { Source } from '@/code/compile/load'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}`) } else { fail++; console.log(`FAIL  ${name}  ${info}`) }
}

// a shared library module both projects load (its file path is identical across projects, like a linked stdlib file)
const lib: Source = {
  file: '/shared/lib.tree',
  text: `task lib-value\n  like number\n  send back\n    mark 7\n`,
}
const resolve = (p: string): Source | undefined =>
  p === '@shared/lib' ? lib : undefined
const entry = (n: number): string =>
  `load @shared/lib\n  find lib-value\n\ntask run\n  like number\n  send back\n    call add\n      call lib-value\n      mark ${n}\n`

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-shared-'))
const shared = path.join(root, 'shared-store')
const localA = path.join(root, 'a')
const localB = path.join(root, 'b')

// project A compiles its app (mill of the lib goes to the SHARED store, output to A-local)
const cacheA = new CompileCache(sharedCacheStore(localA, shared), 'v1')
const a = compile({ file: 'a.tree', text: entry(1) }, { resolve, cache: cacheA })
ok('project A compiles', a.ok)
ok('the shared store now holds the mill entries', fs.existsSync(path.join(shared, 'mill')) && fs.readdirSync(path.join(shared, 'mill')).length > 0)
ok('A output is project-local, not shared', fs.existsSync(path.join(localA, 'output')))

// project B (different entry, fresh in-memory cache, its own local dir) reuses the shared lib mill
const cacheB = new CompileCache(sharedCacheStore(localB, shared), 'v1')
const b = compile({ file: 'b.tree', text: entry(2) }, { resolve, cache: cacheB })
ok('project B compiles', b.ok)
ok('project B reuses the shared lib mill (cross-project)', cacheB.diskHits > 0, `diskHits ${cacheB.diskHits}`)
ok('project B output differs from A (different entry)', a.ok && b.ok && a.typescript !== b.typescript)

fs.rmSync(root, { recursive: true, force: true })
console.log(`\nshared-cache: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
