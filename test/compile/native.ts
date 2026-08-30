// Per-env native resolution test: a public module spells `native/{platform}/<name>` and the build fills the slot
// with the target it is compiling for (node / browser / ...). The user never names a concrete platform; the env
// substitutes, a borrowed sibling env fills a gap (cloudflare -> browser), and the abstract module beside the env
// dirs is the last fallback. The implicit `native/<name>` rewrite is retired (stdlib-parity-0002).
// Run: npx tsx test/compile/native.ts

import { compile } from '@term/make/code/compile/compile'
import { withNativeEnv } from '@term/make/code/compile/native'
import type { Source } from '@term/make/code/compile/load'

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

// an in-memory project: one platform-slotted native module with two platform implementations, plus an
// abstract module that only exists beside the env dirs (the shared fallback)
const modules = new Map<string, string>([
  [
    '@app/code/native/node/platform',
    'task platform-name\n  like text\n  send back, text <node>\n',
  ],
  [
    '@app/code/native/browser/platform',
    'task platform-name\n  like text\n  send back, text <browser>\n',
  ],
  [
    '@app/code/native/shared-only',
    'task shared-name\n  like text\n  send back, text <shared>\n',
  ],
])

const base = (path: string): Source | undefined =>
  modules.has(path)
    ? { file: path, text: modules.get(path)! }
    : undefined

// the public module spells the platform slot; the build fills it
const PUBLIC = `load @app/code/native/{platform}/platform\n  find platform-name\n\ntask describe\n  like text\n  send back\n    call platform-name\n`

const node = compile(
  { file: 'public.tree', text: PUBLIC },
  { resolve: withNativeEnv('node', base) },
)

expect('compiles for the node target', node.ok, true)
expect(
  'node target resolves the node impl',
  node.ok && node.typescript.includes('"node"'),
  true,
)
expect(
  'node target does not pull the browser impl',
  node.ok && !node.typescript.includes('"browser"'),
  true,
)

const browser = compile(
  { file: 'public.tree', text: PUBLIC },
  { resolve: withNativeEnv('browser', base) },
)

expect('compiles for the browser target', browser.ok, true)
expect(
  'browser target resolves the browser impl',
  browser.ok && browser.typescript.includes('"browser"'),
  true,
)

// cloudflare has no impl of its own here: it borrows the browser's (NATIVE_ENV_FALLBACK)
const cloudflare = compile(
  { file: 'public.tree', text: PUBLIC },
  { resolve: withNativeEnv('cloudflare', base) },
)

expect('compiles for the cloudflare target', cloudflare.ok, true)
expect(
  'cloudflare borrows the browser impl',
  cloudflare.ok && cloudflare.typescript.includes('"browser"'),
  true,
)

// an env with no impl at all falls back to the abstract module beside the env dirs
const SHARED = `load @app/code/native/{platform}/shared-only\n  find shared-name\n\ntask describe\n  like text\n  send back\n    call shared-name\n`
const sharedFallback = compile(
  { file: 'public.tree', text: SHARED },
  { resolve: withNativeEnv('node', base) },
)

expect('the abstract module is the last fallback', sharedFallback.ok, true)
expect(
  'the fallback resolves the shared source',
  sharedFallback.ok && sharedFallback.typescript.includes('"shared"'),
  true,
)

// the retired implicit rewrite: an abstract `native/<name>` import no longer resolves an env impl
const ABSTRACT = `load @app/code/native/platform\n  find platform-name\n\ntask describe\n  like text\n  send back\n    call platform-name\n`
const abstract = compile(
  { file: 'public.tree', text: ABSTRACT },
  { resolve: withNativeEnv('node', base) },
)

expect(
  'the implicit abstract rewrite is retired (the import resolves nothing)',
  abstract.ok,
  false,
)

console.log(`\nnative: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
