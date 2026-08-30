// A document renders. Compile a `view`-role document through the full pipeline and run it, confirming it builds
// real DOM through the existing render runtime with its queries passed in as parameters.
//
// This is the one test that closes the whole chain: `.tree` document -> reader -> zone -> zone-lower -> emitted
// component -> mounted nodes. Everything else in test/view asserts a stage. See note/term/view/07-lowering.md.
//
//   npx tsx test/view/document.ts

import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'
import { transform } from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0

function ok(what: string, held: boolean, note = ''): void {
  if (held) {
    pass++
    console.log(`ok    ${what}`)
  } else {
    fail++
    console.log(`FAIL  ${what}  ${note}`)
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const resolve = projectResolver(ROOT, 'node')

// A document. Four statement heads, no head that declares anything: a constant, a query, and the view that
// places components and walks the query's result.
const DOCUMENT = `
host title, text <Vowels>

find vowel
  task <filter:phoneme>
  hold is-equal
    read self/kind
    text <vowel>

view page
  view div
    view span
      text <heading>
    walk list, read vowel
      hook next
        take site, name one
        view li
          text <row>
`

// every text node in a built tree, depth first
function texts(node: any, out: string[] = []): string[] {
  const handle = node?.handle

  if (!handle) {
    return out
  }

  if (handle.text) {
    out.push(handle.text)
  }

  for (const child of handle.children ?? []) {
    texts(child, out)
  }

  return out
}

// The dom docks `<global:html>`, so the native prelude (the one `term boot` prepends) goes first, the way
// test/zone/component.ts does it. The render runtime is inlined into the emitted module, so `element` comes back
// from the module itself rather than from a separate import.
async function run(program: any, typescript: string): Promise<any> {
  const readRuntime = (at: string): string | undefined =>
    fs.existsSync(at) ? fs.readFileSync(at, 'utf8') : undefined

  const js = (
    await transform(`${nativePrelude(program, 'node', readRuntime)}\n${typescript}`, {
      loader: 'ts',
      format: 'esm',
    })
  ).code

  const file = path.join(os.tmpdir(), `term-view-doc-${process.pid}.mjs`)

  fs.writeFileSync(file, js)

  try {
    return await import(file)
  } finally {
    fs.rmSync(file, { force: true })
  }
}

async function main(): Promise<void> {
  const built = compile(
    { file: path.join(ROOT, 'page/doc.tree'), text: DOCUMENT },
    // the role is per FILE. Only the document is a document; the render runtime it pulls in is code, and reading
    // that with the view reader is how this test first failed.
    { resolve, roleOf: file => (file.endsWith('page/doc.tree') ? 'view' : null), treeShake: false },
  )

  ok(
    'a document compiles through the view role',
    built.ok,
    built.ok ? '' : built.diagnostics.map(d => d.message).join(' | '),
  )

  if (!built.ok) {
    return
  }

  ok('it emits one component', /export function page\(/.test(built.typescript), built.typescript.slice(0, 200))
  ok(
    'the component takes the mount host first, then the query',
    /export function page\(\s*host[^)]*vowel/.test(built.typescript.replace(/\n/g, ' ')),
    (built.typescript.match(/export function page\([^)]*\)/) ?? [''])[0],
  )

  const mod = await run(built.program, built.typescript)
  const host = mod.element('root')

  // the query arrives RESOLVED. The renderer never fetches: the host resolves every query first and passes the
  // result in, which is what keeps the component free of input and output. See note/term/view/03-find.md.
  mod.page(host, [{ symbol: 'a' }, { symbol: 'e' }, { symbol: 'i' }])

  const said = texts(host)

  ok('it mounts and renders text', said.length > 0, JSON.stringify(said))
  ok('the static text is there', said.includes('heading'), JSON.stringify(said))
  ok(
    'the walk rendered one node per resolved item',
    said.filter(one => one === 'row').length === 3,
    JSON.stringify(said),
  )

  console.log(`\nview-document: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
