// Bundle the browser compiler (the port of call/code/work/browser/browser-compiling.tree) into ONE self-contained
// module worker, with esbuild. Modeled on
// deck/flow/build.mjs, which bundles the language server the same way: every `@term/*` import resolved through the
// Term package's tsconfig paths and inlined.
//
//   node deck/call/code/browser/build.mjs --out <file.js> [--meta <file.json>]
//
// NOTHING NODE-ONLY SURVIVES. `fs` (either spelling) is the port of work/browser/snapshot-disk.tree in Node's module
// shape, the in-memory snapshot the worker mounts, and `path` is aliased to ./path.ts. Every other Node builtin the compile path's modules import at their top (a CLI module
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
// the Term package root holds the tsconfig with the @term/* path mappings: deck/call/code/browser -> ../../../..
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

// the worker and its disk are the ports of call/code/work/browser (term-cli-in-term-0063), emitted by port-build
const PORT = path.join(termRoot, 'deck', 'call', 'host', 'port', 'code', 'work', 'browser')
const ENTRY = path.join(PORT, 'browser-compiling.ts')
// the snapshot disk's port, the ONE module both the worker's dock and every compiler module's `fs` reach, so the
// snapshot the worker mounts is the one they read. A Term module cannot say Node's module shape (a default export, a
// `promises` record), so `fs` is this port wrapped in that shape by the plugin below, never a copy of it
const DISK = path.join(PORT, 'snapshot-disk.ts')
const DISK_NAMES = [
  'existsSync',
  'readFileSync',
  'statSync',
  'lstatSync',
  'readdirSync',
  'realpathSync',
  'writeFileSync',
  'mkdirSync',
  'appendFileSync',
  'rmSync',
  'renameSync',
  'watch',
  'openSync',
  'closeSync',
  'writeSync',
  'readSync',
  'createWriteStream',
  'createReadStream',
]
const DISK_SHAPE = [
  `import * as disk from ${JSON.stringify(DISK)}`,
  `export const { ${DISK_NAMES.join(', ')} } = disk`,
  'export const promises = { readFile: async (path) => disk.readFileSync(path), writeFile: disk.writeFileSync, mkdir: disk.mkdirSync }',
  `export default { ${DISK_NAMES.join(', ')}, promises }`,
].join('\n')
const diskShape = {
  name: 'snapshot-fs',
  setup(builder) {
    builder.onResolve({ filter: /^(node:)?fs$/ }, () => ({ path: 'fs', namespace: 'snapshot-fs' }))
    builder.onLoad({ filter: /.*/, namespace: 'snapshot-fs' }, () => ({
      contents: DISK_SHAPE,
      loader: 'js',
      resolveDir: PORT,
    }))
  },
}
// the Node builtins the closure names, and what each becomes in the browser
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
  path: PATH,
  'node:path': PATH,
  // the package manager's barrel re-exports its registry, OCI and signing code, all Node. The compile path reads
  // only the role reader from it (call/code/role-of.ts), so the barrel is narrowed to that one module
  '@cluesurf/deck.tree': path.join(termRoot, 'deck', 'deck', 'code', 'package', 'role.ts'),
}

for (const name of ABSENT_BUILTINS) {
  alias[name] = ABSENT
  alias[`node:${name}`] = ABSENT
}

const result = await build({
  entryPoints: [ENTRY],
  plugins: [diskShape],
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
    'import.meta.url': JSON.stringify('file:///term/call/code/browser/worker.js'),
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
