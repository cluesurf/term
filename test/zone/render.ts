// End-to-end render test: compile the `.tree` render runtime + a component through the seed compiler to JS, run it,
// and confirm the mounted DOM node reactively updates when a signal changes. This exercises the whole pipeline:
// parse -> mill -> resolve -> infer -> emit (TypeScript) -> esbuild -> execute. Run: npx tsx test/zone/render.ts

import { compile } from '@/code/compile/compile'
import { projectResolver } from '@/code/call/make'
import { transform } from 'esbuild'
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

const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DECK = path.resolve(SEED, '..')
// resolve through the seed package manager: linked @cluesurf/* packages + the abstract dom API rewritten to the node
// (SSR / headless) native impl by the `node` env.
const resolve = projectResolver(SEED, 'node')

async function main(): Promise<void> {
  const entry = path.join(DECK, 'site.tree/code/test/site/ssr-demo.tree')
  const result = compile({ file: entry, text: fs.readFileSync(entry, 'utf8') }, { resolve })
  ok('the .tree render stack compiles to TypeScript', result.ok, result.ok ? '' : JSON.stringify(result.diagnostics.slice(0, 4)))
  if (!result.ok) {
    console.log(`\nrender: ${pass} pass, ${fail} fail`)
    return
  }

  const js = (await transform(result.typescript, { loader: 'ts', format: 'esm' })).code
  const file = path.join(os.tmpdir(), `seed-render-${process.pid}.mjs`)
  fs.writeFileSync(file, js)
  try {
    const M = (await import(file)) as {
      createElement: (tag: string) => { handle: { children: Array<{ handle: { text: string } }> } }
      buildCounter: (host: unknown) => unknown
      writeSignal: (signal: unknown, value: string) => unknown
    }
    const root = M.createElement('root')
    const count = M.buildCounter(root)
    const mounted = root.handle.children[0]?.handle.text
    ok('component mounts a reactive text node', mounted === '0', JSON.stringify(mounted))
    M.writeSignal(count, '42')
    ok('writing the signal updates the exact DOM node', root.handle.children[0]?.handle.text === '42', JSON.stringify(root.handle.children[0]?.handle.text))
  } finally {
    fs.rmSync(file, { force: true })
  }

  console.log(`\nrender: ${pass} pass, ${fail} fail`)
}

void main()
