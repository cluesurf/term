// In-browser end-to-end: compile the `.tree` app against the browser DOM, bundle it to JS, and run it against a DOM
// stub (a stand-in for `document`). Asserts the app mounts real elements and that clicking the button reactively
// updates the label's text node. Also emits the runnable browser artifacts (index.html + app.js). The browser DOM
// FFI (`import * as dom from "dom"`) is wired to `document` via a tiny shim. Run: npx tsx test/zone/browser.ts

import { compile } from '@/code/compile/compile'
import type { Source } from '@/code/compile/load'
import { build } from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}`) } else { fail++; console.log(`FAIL  ${name}  ${info}`) }
}

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const tryFile = (b: string): Source | undefined => {
  for (const c of [b + '.tree', path.join(b, 'base.tree')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return { file: c, text: fs.readFileSync(c, 'utf8') }
  return undefined
}
// resolve framework + stdlib; the abstract dom API resolves to the browser native impl for this build
function resolve(imp: string, from: string): Source | undefined {
  if (imp.startsWith('@cluesurf/base/code/')) return tryFile(path.join(DECK, 'base.tree/code', imp.slice(20)))
  if (imp.startsWith('@cluesurf/site/code/')) return tryFile(path.join(DECK, 'site.tree/code', imp.slice(20)))
  if (imp.startsWith('./') || imp.startsWith('../')) {
    let p = path.resolve(path.dirname(from), imp)
    if (p.endsWith('/dom/dom')) p = path.join(DECK, 'site.tree/code/dom/native/browser')
    return tryFile(p)
  }
  return undefined
}

// the DOM FFI shim: the browser native calls `dom.createElement` / `dom.createTextNode`; everything else is real DOM
// methods on the element handle. Wires the `import ... from "dom"` to the global document.
const DOM_SHIM = `export const createElement = (tag) => document.createElement(tag)
export const createTextNode = (value) => document.createTextNode(value)
`

// a minimal DOM stub for the headless run (a real browser supplies these natively)
function makeStubElement(tag: string): any {
  return {
    tagName: tag, children: [] as any[], attributes: {} as Record<string, string>, listeners: {} as Record<string, Array<() => void>>, textContent: '',
    setAttribute(n: string, v: string) { this.attributes[n] = v },
    appendChild(c: any) { this.children.push(c); return c },
    addEventListener(e: string, h: () => void) { (this.listeners[e] ??= []).push(h) },
    replaceWith(n: any) { void n },
    fire(e: string) { for (const h of this.listeners[e] ?? []) h() },
  }
}

async function main(): Promise<void> {
  const entry = path.join(DECK, 'site.tree/code/test/site/app.tree')
  const result = compile({ file: entry, text: fs.readFileSync(entry, 'utf8') }, { resolve })
  ok('app compiles against the browser DOM', result.ok, result.ok ? '' : JSON.stringify(result.diagnostics.slice(0, 4)))
  if (!result.ok) { console.log(`\nbrowser: ${pass} pass, ${fail} fail`); return }

  // lay out the bundle inputs in a temp dir: the compiled app, the dom shim, and an entry that mounts onto the body
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-web-'))
  fs.writeFileSync(path.join(dir, 'app.ts'), result.typescript)
  fs.writeFileSync(path.join(dir, 'dom.ts'), DOM_SHIM)
  fs.writeFileSync(path.join(dir, 'entry.ts'), `import { mountApp } from './app'\nmountApp({ handle: document.body })\n`)

  const bundled = await build({
    entryPoints: [path.join(dir, 'entry.ts')],
    bundle: true,
    format: 'esm',
    write: false,
    alias: { dom: path.join(dir, 'dom.ts') },
  })
  const code = bundled.outputFiles[0]!.text
  ok('bundles to a single browser module', code.length > 0)

  // run it headless against the DOM stub
  const body = makeStubElement('body')
  ;(globalThis as any).document = { createElement: makeStubElement, createTextNode: (v: string) => { const n = makeStubElement(''); n.textContent = v; return n }, body }
  const file = path.join(dir, 'bundle.mjs')
  fs.writeFileSync(file, code)
  await import(file)

  const root = body.children[0]
  ok('app mounts a root element', root?.tagName === 'div')
  const button = root?.children[0]
  ok('renders a button', button?.tagName === 'button')
  const labelNode = root?.children[1]
  ok('label starts as the initial signal value', labelNode?.textContent === 'ready', JSON.stringify(labelNode?.textContent))
  button?.fire('click')
  ok('clicking reactively updates the label node', labelNode?.textContent === 'clicked', JSON.stringify(labelNode?.textContent))

  // emit the runnable browser artifacts
  const web = path.join(DECK, 'site.tree/host/web')
  fs.mkdirSync(web, { recursive: true })
  fs.writeFileSync(path.join(web, 'app.js'), code)
  fs.writeFileSync(path.join(web, 'index.html'), `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>Seed app</title></head>\n  <body>\n    <script type="module" src="./app.js"></script>\n  </body>\n</html>\n`)
  ok('emits browser artifacts (index.html + app.js)', fs.existsSync(path.join(web, 'index.html')) && fs.existsSync(path.join(web, 'app.js')))

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\nbrowser: ${pass} pass, ${fail} fail`)
}

void main()
