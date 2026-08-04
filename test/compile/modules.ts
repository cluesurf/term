// Per-module ESM emit test (Tier 2, separate compilation). Compiles a 2-module program in per-module mode, asserts the
// entry module imports the cross-module function + type from the helper, and proves the emitted ESM files actually run
// when wired together (write each module to disk, dynamic-import the entry, call it). Run: npx tsx test/compile/modules.ts

import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import { hashText } from '@term/make/code/compile/cache'
import { projectResolver } from '@term/call/code/make'
import { transform } from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const SEED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

const DECK = path.resolve(SEED, '..')

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

const helper: Source = {
  file: 'helper.tree',
  text: `form point
  link x, like number
  link y, like number

task origin-point
  like point
  send back
    make point
      bind x, code 0
      bind y, code 0

task greeting
  like text
  send back
    text <hi>
`,
}

const entry = `load @app/helper
  find greeting
  find origin-point
  find point

task run
  like text
  send back
    call greeting

task start-point
  like point
  send back
    call origin-point
`

const resolve = (p: string): Source | undefined =>
  p === '@app/helper' ? helper : undefined

// a stable safe filename per source file, and the URL one module imports another by
const safe = (file: string): string => hashText(file)
const urlForFile = (file: string): string => `./${safe(file)}.mjs`

const result = compile(
  { file: 'entry.tree', text: entry },
  { resolve, modules: urlForFile },
)

ok(
  'compiles in per-module mode',
  result.ok,
  result.ok ? '' : JSON.stringify(result.diagnostics?.slice(0, 3)),
)

if (!result.ok) {
  console.log(`\nmodules: ${pass} pass, ${fail} fail`)
  process.exit(1)
}

const modules = result.modules!
ok(
  'emits one module per source file',
  modules.size === 2,
  `size ${modules.size}`,
)

const entryCode = modules.get('entry.tree')?.code ?? ''
const helperCode = modules.get('helper.tree')?.code ?? ''

ok(
  'entry records its dependency edge on the helper',
  modules.get('entry.tree')?.imports.includes('helper.tree') === true,
  JSON.stringify(modules.get('entry.tree')?.imports),
)

ok(
  'entry imports the cross-module function (greeting)',
  /import \{[^}]*\bgreeting\b/.test(entryCode),
  entryCode,
)
ok(
  'entry imports the cross-module function (originPoint)',
  /import \{[^}]*\boriginPoint\b/.test(entryCode),
  entryCode,
)
ok(
  'entry imports the cross-module type (Point)',
  /import type \{[^}]*\bPoint\b/.test(entryCode),
  entryCode,
)
ok(
  'entry imports from the helper url',
  entryCode.includes(`"${urlForFile('helper.tree')}"`),
  entryCode,
)
ok(
  'helper exports the function',
  /export (async )?function greeting/.test(helperCode),
  helperCode,
)
ok(
  'helper has no cross-module import (it defines everything it uses)',
  !/^import /m.test(helperCode),
  helperCode,
)

// integration: transpile each module (TS -> JS, the dev server's per-module transform), write, and run the entry
// through real ESM resolution. This proves the cross-module imports actually resolve and execute.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-modules-'))

for (const [file, emit] of modules) {
  const js = (
    await transform(emit.code, { loader: 'ts', format: 'esm' })
  ).code

  fs.writeFileSync(path.join(dir, `${safe(file)}.mjs`), js)
}

const M = (await import(
  pathToFileURL(path.join(dir, `${safe('entry.tree')}.mjs`)).href
)) as {
  run: () => string
  startPoint: () => { x: number; y: number }
}

ok(
  'the wired ESM modules run: run() returns the helper value',
  M.run() === 'hi',
  JSON.stringify(M.run()),
)
ok(
  'the wired ESM modules run: startPoint() builds the cross-module form',
  M.startPoint().x === 0 && M.startPoint().y === 0,
  JSON.stringify(M.startPoint()),
)
fs.rmSync(dir, { recursive: true, force: true })

// ---- real multi-module app: the blog (native delegation + bear + types + methods) ----
const blogEntry = path.join(
  DECK,
  'seed/deck/site/test/site/hook/blog.tree',
)

const blog = compile(
  { file: blogEntry, text: fs.readFileSync(blogEntry, 'utf8') },
  {
    resolve: projectResolver(SEED, 'node'),
    modules: f => `/${hashText(f)}.mjs`,
  },
)

ok(
  'blog compiles in per-module mode',
  blog.ok,
  blog.ok ? '' : JSON.stringify(blog.diagnostics?.slice(0, 3)),
)

if (blog.ok && blog.modules) {
  const blogModules = blog.modules
  ok(
    'blog emits many modules (full stdlib + framework graph)',
    blogModules.size > 5,
    `size ${blogModules.size}`,
  )

  // every emitted module must transpile to valid JS (no malformed import / emit)
  let bad = ''

  for (const [file, emit] of blogModules) {
    try {
      await transform(emit.code, { loader: 'ts', format: 'esm' })
    } catch (e) {
      bad = `${file}: ${(e as Error).message}`
      break
    }
  }

  ok('every blog module transpiles to valid JS', bad === '', bad)

  // the post repository (native-delegated db) imports the db functions from another module (the impl, via last-wins)
  const postEntry = [...blogModules].find(([f]) =>
    f.endsWith('back/post.tree'),
  )

  const postCode = postEntry?.[1]?.code ?? ''
  ok(
    'post repository imports db functions across modules',
    /import \{[^}]*\b(connect|query|run|field)\b/.test(postCode),
    postCode.slice(0, 240),
  )

  // the API module imports the post repository's functions
  const apiEntry = [...blogModules].find(([f]) =>
    f.endsWith('hook/blog.tree'),
  )

  const apiCode = apiEntry?.[1]?.code ?? ''
  ok(
    'api module imports the repository across modules',
    /import \{[^}]*\b(setup|listPosts|getPost|createPost)\b/.test(
      apiCode,
    ),
    apiCode.slice(0, 240),
  )
}

console.log(`\nmodules: ${pass} pass, ${fail} fail`)

if (fail > 0) {process.exit(1)}
