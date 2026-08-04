// Zone component test: compile a real `zone` (view component) through the full pipeline (parse -> mill -> resolve ->
// infer -> emit) and run it, confirming it builds DOM via the render runtime and that a `read` is reactive (writing the
// signal updates the mounted node). Run: npx tsx test/zone/component.ts

import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
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

const SEED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)
const resolve = projectResolver(SEED, 'node')

const SOURCE = `load @cluesurf/site/code/zone/render
  find element
  find text
  find dynamic
  find attribute
  find event
load @cluesurf/site/code/dom/dom
  find view
  find append
load @cluesurf/site/code/zone/reactive
  find make-signal
  find read-signal
  find write-signal

zone label
  take host, like view
  take value
  zone div
    seed role, text <box>
    read
      call read-signal
        bind self, read value
`

// Stage B: control flow. `fork` lowers to `show` (conditional subtree), `walk` lowers to `each` (list rendering).
const SOURCE_CONTROL = `load @cluesurf/site/code/zone/render
  find element
  find text
  find dynamic
  find show
  find each
load @cluesurf/site/code/dom/dom
  find view
  find append

zone gallery
  take host, like view
  take ready
  take items
  zone ul
    fork
      hook test
        read ready
      hook hold
        zone li
          text <ready>
      hook miss
        zone li
          text <waiting>
    walk list, read items
      hook next
        take site, name row
        zone li
          read
            read row
`

// collect every text node value in a built tree, depth-first
function texts(node: any, out: Array<string> = []): Array<string> {
  const handle = node?.handle
  if (!handle) return out
  if (handle.text) out.push(handle.text)
  for (const child of handle.children ?? []) texts(child, out)
  return out
}

async function run(typescript: string): Promise<any> {
  const js = (
    await transform(typescript, { loader: 'ts', format: 'esm' })
  ).code
  const file = path.join(
    os.tmpdir(),
    `seed-zone-${process.pid}-${pass + fail}.mjs`,
  )
  fs.writeFileSync(file, js)
  try {
    return await import(file)
  } finally {
    fs.rmSync(file, { force: true })
  }
}

async function main(): Promise<void> {
  const result = compile(
    { file: 'zone.tree', text: SOURCE },
    { resolve },
  )
  ok(
    'a zone compiles through resolve + infer + emit',
    result.ok,
    result.ok ? '' : JSON.stringify(result.diagnostics.slice(0, 4)),
  )
  if (!result.ok) {
    console.log(`\nzone: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  ok(
    'emits a component function',
    /export function label/.test(result.typescript),
    '',
  )
  ok(
    'emits a positional element call',
    /element\("div"\)/.test(result.typescript),
  )
  ok(
    'emits a reactive dynamic node',
    /dynamic\(\(\) =>/.test(result.typescript),
  )

  // run it against the headless (node) dom
  const js = (
    await transform(result.typescript, { loader: 'ts', format: 'esm' })
  ).code
  const file = path.join(os.tmpdir(), `seed-zone-${process.pid}.mjs`)
  fs.writeFileSync(file, js)
  try {
    const M = (await import(file)) as {
      label: (host: any, value: any) => void
      element: (tag: string) => any
      makeSignal: (value: string) => any
      writeSignal: (self: unknown, value: string) => unknown
    }
    // render-runtime calls are positional, matching code/zone/render.tree + reactive.tree task signatures
    const host = M.element('root')
    const signal = M.makeSignal('hello')
    M.label(host, signal)
    const mounted = () =>
      host.handle?.children?.[0]?.handle?.children?.[0]?.handle?.text
    ok(
      'the zone mounts a reactive text node',
      mounted() === 'hello',
      String(mounted()),
    )
    M.writeSignal(signal, 'world')
    ok(
      'writing the signal updates the mounted node (reactive)',
      mounted() === 'world',
      String(mounted()),
    )
    // the `seed role, text <box>` attribute went through the render `attribute` call -> dom set-attribute
    const div = host.handle?.children?.[0]
    const attrs: Array<{ name: string; value: string }> =
      div?.handle?.attributes ?? []
    ok(
      'an attribute is set on the element',
      attrs.some(a => a.name === 'role' && a.value === 'box'),
      JSON.stringify(attrs),
    )
  } catch (e) {
    ok('the zone runs', false, String((e as Error).message))
    console.log('--- emitted ---')
    console.log(
      result.typescript
        .split('\n')
        .filter(l => /label|element|dynamic|append/.test(l))
        .join('\n'),
    )
  } finally {
    fs.rmSync(file, { force: true })
  }

  // Stage B: fork -> show, walk -> each
  const control = compile(
    { file: 'control.tree', text: SOURCE_CONTROL },
    { resolve },
  )
  ok(
    'a control-flow zone compiles',
    control.ok,
    control.ok ? '' : JSON.stringify(control.diagnostics.slice(0, 4)),
  )
  if (control.ok) {
    ok('fork lowers to a show call', /show\(/.test(control.typescript))
    ok('walk lowers to an each call', /each\(/.test(control.typescript))
    try {
      const M = await run(control.typescript)
      const host = M.element('root')
      M.gallery(host, true, ['a', 'b', 'c'])
      const found = texts(host)
      ok(
        'show renders the active branch',
        found.includes('ready') && !found.includes('waiting'),
        found.join(','),
      )
      ok(
        'each renders one node per item',
        ['a', 'b', 'c'].every(t => found.includes(t)),
        found.join(','),
      )
    } catch (e) {
      ok(
        'the control-flow zone runs',
        false,
        String((e as Error).message),
      )
    }
  }

  console.log(`\nzone: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

void main()
