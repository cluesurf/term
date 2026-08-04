// Per-env native resolution test: a public module forwards to an abstract `native/<name>` import, and the build picks
// the concrete platform impl (node / browser / ...). The user never names a platform; the target the build chooses
// selects the implementation. Run: npx tsx test/compile/native.ts

import { compile } from '@term/make/code/compile/compile'
import {
  withNativeEnv,
  nativeImportFor,
} from '@term/make/code/compile/native'
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

// the abstract import rewrites to the env-specific one, and leaves an already-concrete import alone
expect(
  'abstract native path -> node',
  nativeImportFor('@app/code/native/file', 'node'),
  '@app/code/native/node/file',
)
expect(
  'abstract native path -> browser',
  nativeImportFor('@app/code/native/file', 'browser'),
  '@app/code/native/browser/file',
)
expect(
  'nested abstract native path rewrites the env segment',
  nativeImportFor('@app/code/native/file/read', 'rust'),
  '@app/code/native/rust/file/read',
)
expect(
  'already-concrete native path is left alone',
  nativeImportFor('@app/code/native/node/file', 'browser'),
  undefined,
)
expect(
  'non-native path is not rewritten',
  nativeImportFor('@app/code/list', 'node'),
  undefined,
)

// an in-memory project: one abstract native module with two platform implementations
const modules = new Map<string, string>([
  [
    '@app/code/native/node/platform',
    'task platform-name\n  like text\n  send back, text <node>\n',
  ],
  [
    '@app/code/native/browser/platform',
    'task platform-name\n  like text\n  send back, text <browser>\n',
  ],
])

const base = (path: string): Source | undefined =>
  modules.has(path)
    ? { file: path, text: modules.get(path)! }
    : undefined

// the public module imports the ABSTRACT native path; it never names a platform
const PUBLIC = `load @app/code/native/platform\n  find platform-name\n\ntask describe\n  like text\n  send back\n    call platform-name\n`

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

console.log(`\nnative: ${pass} pass, ${fail} fail`)

if (fail > 0) {process.exit(1)}
