// Stateful zone HMR, end to end. Compile a zone app in per-module mode (so each module is its own ESM file with the
// hot wiring emitZone + emitModules emit), write every module to disk, run it against the headless dom, change a
// signal, then drive the real `applyHmr` through an actual re-import of an edited module. The signal value must
// survive the swap and the freshly compiled view must be the one mounted. Run: npx tsx test/dev/zone-hmr.ts

import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { applyHmr } from '@term/make/code/dev/client'
import type { HmrEnvironment } from '@term/make/code/dev/client'
import { transform } from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

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

const resolve = projectResolver(process.cwd(), 'node')

// a zone reading a signal, with a static label so v1 and v2 are visibly different
const app = (
  label: string,
): string => `load @cluesurf/site/code/zone/render
  find element
  find text
  find dynamic
load @cluesurf/site/code/dom/dom
  find view
  find append
load @cluesurf/site/code/zone/reactive
  find make-signal
  find read-signal

zone counter
  take host, like view
  save count
    call make-signal
      code 0
  zone div
    text <${label}>
    read
      call read-signal
        bind self, read count
`

// a stable, query-stripped boundary registry, exactly like the browser client installs as window.__seedHot
function installHot(): Map<
  string,
  {
    data: any
    accept?: (m: unknown) => void
    dispose?: (d: unknown) => void
  }
> {
  const registry = new Map<string, any>()

  ;(globalThis as any).__seedHot = (url: string) => {
    const key = url.split('?')[0]

    let entry = registry.get(key)

    if (!entry) {
      entry = { data: {} }
      registry.set(key, entry)
    }

    return {
      get data() {
        return entry.data
      },
      accept(cb: (m: unknown) => void) {
        entry.accept = cb
      },
      dispose(cb: (d: unknown) => void) {
        entry.dispose = cb
      },
      invalidate() {},
    }
  }

  return registry
}

const safe = (file: string): string =>
  file.replace(/[^a-z0-9]+/gi, '_') + '.mjs'

async function main(): Promise<void> {
  // realpath so the path matches Node's resolved import.meta.url (macOS /var vs /private/var), which keys the registry
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'seed-zone-hmr-')),
  )

  const ENTRY = 'face/counter.tree'
  const url = (file: string): string => './' + safe(file)

  // compile v1 in per-module mode and write every module (transformed to JS) to disk
  const v1 = compile(
    { file: ENTRY, text: app('v1') },
    { resolve, modules: url },
  )

  ok(
    'v1 compiles in per-module mode',
    v1.ok && !!v1.modules,
    v1.ok ? '' : JSON.stringify((v1 as any).diagnostics?.slice(0, 3)),
  )

  if (!v1.ok || !v1.modules) {
    console.log(`\nzone-hmr: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  const entryMod = v1.modules.get(ENTRY)!
  ok('the zone module is a self-accepting boundary', entryMod.isZone)
  ok(
    'it emits the hot boundary wiring',
    /hot\.accept\(/.test(entryMod.code) &&
      /hot\.dispose\(/.test(entryMod.code),
  )
  ok(
    'it seeds signals from the kept snapshot',
    /makeSignal\("count" in __seed/.test(entryMod.code),
  )

  for (const [file, emit] of v1.modules) {
    const js = (
      await transform(emit.code, { loader: 'ts', format: 'esm' })
    ).code

    fs.writeFileSync(path.join(dir, safe(file)), js)
  }

  const registry = installHot()
  const entryPath = path.join(dir, safe(ENTRY))
  const entryUrl = pathToFileURL(entryPath).href

  // import the runtime helpers we need to drive the dom + signals (from the written reactive / render / dom modules)
  const reactiveFile = [...v1.modules.keys()].find(f =>
    f.includes('reactive'),
  )!

  const renderFile = [...v1.modules.keys()].find(f =>
    f.includes('render'),
  )!

  const reactive = (await import(
    pathToFileURL(path.join(dir, safe(reactiveFile))).href
  )) as {
    readSignal: (s: any) => unknown
    writeSignal: (s: any, v: unknown) => unknown
  }

  const render = (await import(
    pathToFileURL(path.join(dir, safe(renderFile))).href
  )) as { element: (t: string) => any }

  const host = render.element('root')
  const moduleV1 = (await import(entryUrl)) as {
    counter: (h: any) => void
  }

  moduleV1.counter(host)

  const texts = (): string[] => {
    const out: string[] = []

    const walk = (n: any): void => {
      // text nodes hold either a static string or a signal value (a number); compare as strings
      if (n?.handle?.text !== undefined && n.handle.text !== '')
        {out.push(String(n.handle.text))}

      for (const c of n?.handle?.children ?? []) {walk(c)}
    }

    walk(host)

    return out
  }

  ok(
    'v1 mounts with its label',
    texts().includes('v1'),
    texts().join(','),
  )

  // change the signal, then read it back through the live instance to confirm it is reactive before the swap
  const data = registry.get(entryUrl)!.data
  const liveSignal = data.instances[0].signals.count
  reactive.writeSignal(liveSignal, 7)
  ok(
    'the live signal updates the view',
    texts().includes('7'),
    texts().join(','),
  )

  // EDIT: recompile with a new label and overwrite the entry module on disk (same url, cache-busted on reimport)
  const v2 = compile(
    { file: ENTRY, text: app('v2') },
    { resolve, modules: url },
  )

  if (!v2.ok || !v2.modules) {throw new Error('v2 compile failed')}

  const v2js = (
    await transform(v2.modules.get(ENTRY)!.code, {
      loader: 'ts',
      format: 'esm',
    })
  ).code

  fs.writeFileSync(entryPath, v2js)

  // drive the real client: dispose (snapshot + tear down) -> reimport fresh -> accept (re-mount from snapshot)
  let reloaded = false
  let stamp = 1

  const environment: HmrEnvironment = {
    reload: () => {
      reloaded = true
    },
    reimport: (u, t) => import(u + '?t=' + t),
    acceptOf: b => registry.get(b.split('?')[0])?.accept,
    disposeOf: b => {
      const e = registry.get(b.split('?')[0])

      return e?.dispose ? () => e.dispose!(e.data) : undefined
    },
    log: () => {},
  }

  await applyHmr(
    {
      type: 'update',
      updates: [
        { boundary: entryUrl, accepted: entryUrl, timestamp: ++stamp },
      ],
    },
    environment,
  )

  ok('the swap did not fall back to a full reload', !reloaded)
  ok(
    'the fresh view (v2) is mounted',
    texts().includes('v2') && !texts().includes('v1'),
    texts().join(','),
  )
  ok(
    'the signal value survived the swap',
    texts().includes('7'),
    texts().join(','),
  )

  const newInstance = registry.get(entryUrl)!.data.instances[0]
  ok(
    'the re-mounted instance restored the signal',
    reactive.readSignal(newInstance.signals.count) === 7,
    String(reactive.readSignal(newInstance.signals.count)),
  )

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\nzone-hmr: ${pass} pass, ${fail} fail`)

  if (fail > 0) {process.exit(1)}
}

void main()
