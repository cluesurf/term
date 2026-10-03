// Bundle the browser compiler (./worker.ts) into ONE self-contained module worker, with esbuild. Modeled on
// deck/flow/build.mjs, which bundles the language server the same way: every `@term/*` import resolved through the
// Term package's tsconfig paths and inlined.
//
//   node deck/make/code/browser/build.mjs --out <file.js> [--meta <file.json>]
//
// NOTHING NODE-ONLY SURVIVES. `fs` and `path` (either spelling) are aliased to ./disk.ts and ./path.ts, the in-memory
// snapshot the worker mounts. Every other Node builtin the compile path's modules import at their top (a CLI module
// that also spawns, hashes or reads the clock) goes to ./absent.ts, which throws if it is ever CALLED: the compile and
// emit path never calls one, and a call would be a defect worth hearing about rather than a silent stub. The one
// dynamic `esbuild` import in the build driver is external, as in deck/flow/build.mjs: it sits inside a lazy
// initializer `term make --parallel` reaches and the worker never does.
//
// The bundle is then READ BACK and refused if any `require(` or `import` of a Node builtin is left in it, so a new
// Node import in the compile path fails this build rather than a reader's browser.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
// the Term package root holds the tsconfig with the @term/* path mappings: deck/make/code/browser -> ../../../..
const termRoot = path.resolve(here, '..', '..', '..', '..')
const argument = name => {
  const at = process.argv.indexOf(name)

  return at > 0 ? process.argv[at + 1] : undefined
}
const outfile = argument('--out')
const metafile = argument('--meta')

if (!outfile) {
  process.stderr.write('usage: node build.mjs --out <file.js> [--meta <file.json>]\n')
  process.exit(2)
}

// the Node builtins the closure names, and what each becomes in the browser
const DISK = path.join(here, 'disk.ts')
const PATH = path.join(here, 'path.ts')
const ABSENT = path.join(here, 'absent.ts')
// only what the closure imports today. Any other builtin is left unaliased, so under `platform: 'browser'` esbuild
// cannot resolve it and the build fails naming the importer, which is the point
const ABSENT_BUILTINS = ['url']
// what the bundle must not still import, read back after the build
const NODE_BUILTINS = [
  'fs',
  'fs/promises',
  'path',
  'url',
  'child_process',
  'os',
  'crypto',
  'util',
  'worker_threads',
  'module',
  'events',
  'stream',
  'zlib',
  'http',
  'https',
  'net',
  'readline',
  'process',
  'buffer',
  'vm',
]
const alias = {
  fs: DISK,
  'node:fs': DISK,
  path: PATH,
  'node:path': PATH,
  // the package manager's barrel re-exports its registry, OCI and signing code, all Node. The compile path reads
  // only the role reader from it (call/code/role-of.ts), so the barrel is narrowed to that one module
  '@cluesurf/deck.tree': path.join(termRoot, 'deck', 'deck', 'code', 'role.ts'),
}

for (const name of ABSENT_BUILTINS) {
  alias[name] = ABSENT
  alias[`node:${name}`] = ABSENT
}

const result = await build({
  entryPoints: [path.join(here, 'worker.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  tsconfig: path.join(termRoot, 'tsconfig.json'),
  alias,
  external: ['esbuild'],
  // `stdlibBase()` reads TERM_STDLIB before it tries to walk up from its own file url, and the worker mounts the
  // snapshot at exactly this path (worker.ts, STDLIB_ROOT). The one other `process` read in the closure is guarded
  // by `typeof process`, so a worker needs no `process` at all
  define: {
    'process.env.TERM_STDLIB': JSON.stringify('/term/base'),
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.url': JSON.stringify('file:///term/make/code/browser/worker.js'),
  },
  metafile: true,
})

const text = readFileSync(outfile, 'utf8')
const left = NODE_BUILTINS.filter(name =>
  new RegExp(`(require\\(|from\\s*|import\\(\\s*)["'](node:)?${name.replace('/', '\\/')}["']`).test(text),
)

if (left.length > 0) {
  process.stderr.write(`refused: the bundle still imports ${left.join(', ')}\n`)
  process.exit(1)
}

if (metafile) {
  writeFileSync(metafile, JSON.stringify(result.metafile))
}

process.stdout.write(`built ${path.relative(process.cwd(), outfile)} (${text.length} bytes), no Node builtin left\n`)
