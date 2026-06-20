// Live Postgres persistence test: compile the posts repository (which uses only the abstract @cluesurf/site/code/base/db),
// prepend the Postgres runtime shim (what the native-env prelude does), bundle, and run it against the local Postgres.
// Asserts the schema is created, posts persist, list returns them in order, and get-by-id reads one back.
// Run: npx tsx test/site/blog-db.ts   (set DATABASE_URL to override the connection)

import { compile } from '@/code/compile/compile'
import { projectResolver } from '@/code/call/make'
import { nativePrelude } from '@/code/compile/native'
import { build } from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const SEED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)
const DECK = path.resolve(SEED, '..')
const resolve = projectResolver(SEED, 'node')
const CONN =
  process.env.DATABASE_URL ??
  'postgresql://lancepollard@localhost:5432/postgres'

type Post = { id: string; title: string; body: string }
type Repo = {
  setup: (url: string) => Promise<void>
  run: (sql: string, params: Array<unknown>) => Promise<void>
  createPost: (id: string, title: string, body: string) => Promise<void>
  listPosts: () => Promise<Array<Post>>
  getPost: (id: string) => Promise<Post>
  close?: () => Promise<void>
}

async function main(): Promise<void> {
  const entry = path.join(DECK, 'site.tree/test/site/back/post.tree')
  const result = compile(
    { file: entry, text: fs.readFileSync(entry, 'utf8') },
    { resolve },
  )
  ok(
    'repository compiles against the abstract db',
    result.ok,
    result.ok ? '' : JSON.stringify(result.diagnostics.slice(0, 4)),
  )
  if (!result.ok) {
    console.log(`\nblog-db: ${pass} pass, ${fail} fail`)
    return
  }

  // userland never imports pg: the compiled output references the `postgres` namespace from the prelude shim, never the
  // driver directly.
  ok(
    'compiled userland has no pg import',
    !/from ['"]pg['"]/.test(result.typescript),
  )

  // the native-env prelude (the same one `seed boot` prepends): nativePrelude auto-discovers the <global:postgres> shim
  // next to the module that docks it. Then bundle with pg left external (resolved from node_modules).
  const readRuntime = (p: string): string | undefined =>
    fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined
  const prelude = nativePrelude(result.program, 'node', readRuntime)
  // run the bundle inside the seed package so node resolves the external `pg` from its node_modules
  const tmp = path.join(SEED, 'test', 'tmp')
  fs.mkdirSync(tmp, { recursive: true })
  const dir = fs.mkdtempSync(path.join(tmp, 'blogdb-'))
  fs.writeFileSync(
    path.join(dir, 'app.ts'),
    `${prelude}\n${result.typescript}`,
  )
  const bundled = await build({
    entryPoints: [path.join(dir, 'app.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['pg'],
    write: false,
  })
  const code = bundled.outputFiles[0]!.text
  ok('bundles to a single node module', code.length > 0)
  const file = path.join(dir, 'app.mjs')
  fs.writeFileSync(file, code)

  let M: Repo
  try {
    M = (await import(file)) as unknown as Repo
    await M.setup(CONN)
    ok('connects to Postgres + ensures schema', true)
  } catch (e) {
    ok(
      'connects to Postgres + ensures schema',
      false,
      String((e as Error).message),
    )
    console.log(
      `\nblog-db: ${pass} pass, ${fail} fail  (is Postgres running? set DATABASE_URL)`,
    )
    fs.rmSync(dir, { recursive: true, force: true })
    return
  }

  await M.run('DELETE FROM post', []) // start clean
  await M.createPost('p1', 'First Post', 'Hello world')
  await M.createPost('p2', 'Second Post', 'More text')

  const posts = await M.listPosts()
  ok('two posts persisted', posts.length === 2, JSON.stringify(posts))
  ok(
    'first post read back',
    posts[0]?.id === 'p1' &&
      posts[0]?.title === 'First Post' &&
      posts[0]?.body === 'Hello world',
    JSON.stringify(posts[0]),
  )
  ok(
    'second post read back',
    posts[1]?.id === 'p2' && posts[1]?.title === 'Second Post',
    JSON.stringify(posts[1]),
  )

  const one = await M.getPost('p2')
  ok(
    'get-by-id reads a single post',
    one?.id === 'p2' &&
      one?.title === 'Second Post' &&
      one?.body === 'More text',
    JSON.stringify(one),
  )

  if (M.close) await M.close()
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\nblog-db: ${pass} pass, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
