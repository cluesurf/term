// Full-stack loop test: compile the blog API (trie router + Postgres repository), prepend both runtime shims (Postgres
// + hono), bundle, start it on a port, seed two posts into Postgres, then fetch `/posts` and `/posts/:id` over real HTTP
// and assert the JSON came back through hono -> trie router -> Postgres. This is the complete backend loop end to end.
// Run: npx tsx test/site/blog-loop.ts   (set DATABASE_URL to override the connection)

import { compile } from '@cluesurf/make/code/compile/compile'
import { projectResolver } from '@cluesurf/call/code/make'
import { nativePrelude } from '@cluesurf/make/code/compile/native'
import { build } from 'esbuild'
import * as fs from 'node:fs'
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

const PORT = 38571

async function main(): Promise<void> {
  const entry = path.join(
    DECK,
    'seed/deck/site/test/site/hook/blog.tree',
  )

  const result = compile(
    { file: entry, text: fs.readFileSync(entry, 'utf8') },
    { resolve },
  )

  ok(
    'blog API compiles against the abstract db + http',
    result.ok,
    result.ok ? '' : JSON.stringify(result.diagnostics.slice(0, 4)),
  )

  if (!result.ok) {
    console.log(`\nblog-loop: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  ok(
    'userland has no driver imports',
    !/from ['"]pg['"]/.test(result.typescript) &&
      !/from ['"]hono['"]/.test(result.typescript),
  )

  // the native-env prelude (the same one `seed boot` prepends): nativePrelude auto-discovers each <global:X> shim next
  // to the module that docks it. Then bundle with the drivers left external.
  const readRuntime = (p: string): string | undefined =>
    fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined

  const prelude = nativePrelude(result.program, 'node', readRuntime)
  const tmp = path.join(SEED, 'test', 'tmp')
  fs.mkdirSync(tmp, { recursive: true })

  const dir = fs.mkdtempSync(path.join(tmp, 'blogloop-'))
  fs.writeFileSync(
    path.join(dir, 'app.ts'),
    `${prelude}\n${result.typescript}`,
  )

  const bundled = await build({
    entryPoints: [path.join(dir, 'app.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['pg', 'hono', '@hono/node-server'],
    write: false,
  })

  const file = path.join(dir, 'app.mjs')
  fs.writeFileSync(file, bundled.outputFiles[0].text)

  type Api = {
    start: (url: string, port: number) => Promise<void>
    reset: () => Promise<void>
    seedPost: (id: string, title: string, body: string) => Promise<void>
  }
  let M: Api

  try {
    M = await import(file)
    await M.start(CONN, PORT)
    await new Promise(r => setTimeout(r, 250))
    ok('connects to Postgres + starts hono', true)
  } catch (e) {
    ok(
      'connects to Postgres + starts hono',
      false,
      String((e as Error).message),
    )
    console.log(
      `\nblog-loop: ${pass} pass, ${fail} fail  (is Postgres running? set DATABASE_URL)`,
    )
    fs.rmSync(dir, { recursive: true, force: true })
    process.exit(1)
  }

  await M.reset()
  await M.seedPost('p1', 'First Post', 'Hello world')
  await M.seedPost('p2', 'Second Post', 'More text')

  const get = async (
    p: string,
  ): Promise<{ status: number; json: unknown }> => {
    const r = await fetch(`http://localhost:${PORT}${p}`)

    return { status: r.status, json: JSON.parse(await r.text()) }
  }

  const list = await get('/posts')
  const posts = list.json as {
    id: string
    title: string
    body: string
  }[]

  ok(
    'GET /posts returns the two posts as JSON',
    list.status === 200 && posts.length === 2,
    JSON.stringify(list.json),
  )
  ok(
    'first post came through the loop (Postgres -> trie -> hono -> fetch)',
    posts[0]?.id === 'p1' &&
      posts[0]?.title === 'First Post' &&
      posts[0]?.body === 'Hello world',
    JSON.stringify(posts[0]),
  )
  ok(
    'second post too',
    posts[1]?.id === 'p2' && posts[1]?.title === 'Second Post',
    JSON.stringify(posts[1]),
  )

  const one = await get('/posts/p2')
  const single = one.json as { id: string; title: string; body: string }
  ok(
    'GET /posts/:id binds the id and reads one post',
    one.status === 200 &&
      single.id === 'p2' &&
      single.title === 'Second Post' &&
      single.body === 'More text',
    JSON.stringify(one.json),
  )

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\nblog-loop: ${pass} pass, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
