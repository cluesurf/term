// The per-module TypeScript emit binds a view's runtime calls as render.tree binds them (beat-term-0056, decision D020,
// review 0045 finding 2). Compile's `modules` option (the dev server, and the separate unit build in compile/separate.ts)
// emits a view through ts-emit's `emit-zone`, which wrote the plain render names, and module-emit's import planner
// imported the plain names. When the entry (or a loaded module) defines a name render.tree's own runtime also defines,
// the build splits it by file (`append` and `append__in0_<k>`), so the zone called the entry's own `append`, or an
// `append` it never imported. Nothing here RUNS the emitted modules or touches a simulator or a window: it reads the
// entry module's text.
//
//   none           nothing split: the output is what it was, the dom's plain `append`, imported plainly
//   entry-append   the entry defines `append`: the zone calls the dom's, imported under the name the build bound
//   module-append  a loaded module defines `append`: the zone calls the dom's, the module's glue is another import
//   entry-scope    the entry defines `remove` and `open-scope`: the zone's scope call and the hot epilogue's `remove`
//                  call the bound names too
//
// Run: sh tmp/beat-tsx.sh test/compile/view-module-split.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import type { Resolver } from '@term/make/code/compile/load'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(-1600)}`)
  }
}

const ROOT = process.cwd()
// a fixed folder under the Term root's own tmp/, overwritten each run: a program outside the project root does not bind
// a relative load (`find append, name glue` of ./extra) and the checker reads the glue call as the dom's
const HERE = join(ROOT, 'tmp', 'view-module-split')
const SITE = `file://${ROOT}/deck/site/code`

// the memory dom stands in for the toolkit's: nothing is run, and nothing here needs a window
const pinned: Resolver = (() => {
  const base = projectResolver(ROOT, 'node')

  return (importPath, fromFile) => base(importPath.replace(/native\/\{platform\}\/(dom|device|view)$/, 'native/memory/$1'), fromFile)
})()

const VIEW = `
view tally
  take host, like view
  view span
    text <low>
`

const loads = (dom: string[]): string => `load @term/site/code/view/render
  find make-element

load @term/site/code/dom/dom
${['view', ...dom].map(n => `  find ${n}`).join('\n')}

load @term/site/code/dom/native/memory/dom
  find create-element
  find serialize
`

const OWN = `
task append
  take first, like text
  take second, like text
  like text
  send back, text <{first}{second}>
`

const OWN_SCOPE = `
task remove
  take node, like text
  like text
  send back, read node

task open-scope
  like text
  send back, text <scope>
`

const RUN = (extra: string): string => `
task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call tally
    read root
${extra}  send back
    call serialize
      read root
`

const CASES: [string, Record<string, string>][] = [
  ['none', { 'main.tree': loads(['append']) + VIEW + RUN('') }],
  ['entry-append', { 'main.tree': loads([]) + OWN + VIEW + RUN('  save more\n    call append\n      text <x>\n      text <y>\n') }],
  [
    'module-append',
    {
      'main.tree': `${loads([])}\nload ./extra\n  find append, name glue\n${VIEW}${RUN('  save more\n    call glue\n      text <x>\n      text <y>\n')}`,
      'extra.tree': OWN,
    },
  ],
  [
    'entry-scope',
    {
      'main.tree': loads([]) + OWN_SCOPE + VIEW + RUN('  save more\n    call remove\n      call open-scope\n'),
    },
  ],
]

// what a module imports, by local name, with the file it comes from (type imports skipped)
function importsOf(code: string): Map<string, string> {
  const out = new Map<string, string>()

  for (const line of code.split('\n')) {
    const found = /^import \{([^}]*)\} from "([^"]*)"/.exec(line)

    if (!found) {
      continue
    }

    for (const part of found[1]!.split(',')) {
      const local = part.trim().split(/\s+as\s+/).pop()!

      out.set(local, found[2]!)
    }
  }

  return out
}

const definesIn = (code: string): Set<string> =>
  new Set([...code.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)].map(m => m[1]!))

// every free call of the render runtime's names: not a member call, not a definition
function callsIn(code: string, names = /^(?:append|makeElement|makeText|openScope|closeScope|makeSignal|readSignal|disposeScope|remove)\w*$/): string[] {
  const out: string[] = []

  for (const match of code.matchAll(/(?<![.\w])(\w+)\(/g)) {
    const name = match[1]!

    if (names.test(name) && !code.slice(0, match.index).endsWith('function ')) {
      out.push(name)
    }
  }

  return out
}

// the module's own `export function <name>(...) {` through its closing brace at the start of a line
function bodyOf(code: string, name: string): string {
  const from = code.indexOf(`export function ${name}(`)
  const to = code.indexOf('\n}\n', from)

  return from >= 0 && to >= 0 ? code.slice(from, to + 2) : ''
}

const isRuntimeFile = (url: string): boolean => /\/(?:dom\/dom|dom\/native\/[^/]+\/dom|view\/render|view\/reactive)\.tree$/.test(url)

// today's output for a program where the build split nothing, with the file URLs of this checkout
const NONE_EXPECTED = `import { append, createElement, remove, serialize } from "${SITE}/dom/native/memory/dom.tree"
import { attachEvent, makeDynamicText, makeElement, makeText, renderEach, show, writeAttribute } from "${SITE}/view/render.tree"
import { closeScope, disposeScope, makeSignal, openScope, readSignal } from "${SITE}/view/reactive.tree"
import type { View } from "${SITE}/dom/native/memory/view.tree"

const hot = typeof __seedHot !== "undefined" ? __seedHot(import.meta.url) : undefined

export function tally(host: View) {
  const __seed = (hot && hot.data.signals && hot.data.signals["tally"]) || {}
  const __scope = openScope()
  const view0 = makeElement("span")
  const view1 = makeText("low")
  append(view0, view1)
  append(host, view0)
  closeScope()
  if (hot) (hot.data.instances || (hot.data.instances = [])).push({ zone: "tally", host: host, signals: {  }, scope: __scope, nodes: [view0] })
}

export function run(): string {
  const root: View = createElement("main")
  tally(root)
  return serialize(root)
}


if (hot) {
  hot.dispose((data) => {
    data.signals = {}
    data.remount = []
    for (const inst of (data.instances || [])) {
      const snapshot = {}
      for (const key in inst.signals) snapshot[key] = readSignal(inst.signals[key])
      data.signals[inst.zone] = snapshot
      disposeScope(inst.scope)
      for (const node of inst.nodes) remove(node)
      data.remount.push({ zone: inst.zone, host: inst.host })
    }
    data.instances = []
  })
  hot.accept((mod) => {
    for (const entry of (hot.data.remount || [])) mod[entry.zone](entry.host)
    hot.data.remount = []
  })
}`

const codes = new Map<string, string>()

for (const [name, files] of CASES) {
  const folder = join(HERE, name)
  mkdirSync(folder, { recursive: true })

  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(folder, file), text)
  }

  const entry = join(folder, 'main.tree')
  const result = compile({ file: entry, text: files['main.tree']! }, { resolve: pinned, env: 'node', modules: f => `file://${f}` })

  ok(`${name}: compiles with modules`, result.ok, result.ok ? '' : result.diagnostics.slice(0, 3).map(d => d.message).join(' | '))

  if (!result.ok) {
    continue
  }

  const code = result.modules?.get(entry)?.code ?? ''
  writeFileSync(join(folder, 'main.module.ts'), code)
  codes.set(name, code)

  const imports = importsOf(code)
  const defines = definesIn(code)
  const zone = bodyOf(code, 'tally')

  ok(`${name}: the entry module holds the zone`, zone !== '', code.slice(0, 400))

  // every free call of a runtime name is an import or the module's own definition
  const dangling = callsIn(code).filter(call => !imports.has(call) && !defines.has(call))

  ok(`${name}: every free runtime call is imported or defined in the module`, dangling.length === 0, dangling.join(', '))

  // the zone's own calls (the view's lowering) come from the dom's or render.tree's module, never from the entry
  const fromEntry = callsIn(zone).filter(call => !isRuntimeFile(imports.get(call) ?? ''))

  ok(`${name}: the zone's runtime calls come from the dom's, render's or reactive's module`, fromEntry.length === 0, fromEntry.join(', '))

  // the hot epilogue's calls too
  const epilogue = callsIn(code.slice(code.indexOf('if (hot) {\n  hot.dispose')))
  const loose = epilogue.filter(call => !isRuntimeFile(imports.get(call) ?? ''))

  ok(`${name}: the hot epilogue calls the runtime's own readSignal, disposeScope and remove`, epilogue.length === 3 && loose.length === 0, epilogue.join(', '))
}

const none = codes.get('none')

if (none !== undefined) {
  ok('none: the output is what it was, the dom\'s plain append imported plainly', none === NONE_EXPECTED, none)
}

const entryAppend = codes.get('entry-append')

if (entryAppend !== undefined) {
  const zone = bodyOf(entryAppend, 'tally')
  const imports = importsOf(entryAppend)
  const zoneAppend = callsIn(zone, /^append\w*$/)

  ok('entry-append: the entry keeps its own append', definesIn(entryAppend).has('append'))
  ok('entry-append: the zone\'s append call is not the entry\'s own append', zoneAppend.length === 2 && !zoneAppend.includes('append'), zoneAppend.join(', '))
  ok(
    'entry-append: the zone\'s append is the dom\'s, imported under the name the build bound',
    zoneAppend.every(name => /dom\/native\/memory\/dom\.tree$/.test(imports.get(name) ?? '')) && !imports.has('append'),
    `${zoneAppend.join(', ')} from ${[...imports].filter(([n]) => n.startsWith('append')).join(' ')}`,
  )
  ok('entry-append: the entry\'s own call still reaches its own append', /(?<![.\w])append\("x", "y"\)/.test(entryAppend), entryAppend.slice(-800))
}

const moduleAppend = codes.get('module-append')

if (moduleAppend !== undefined) {
  const zone = bodyOf(moduleAppend, 'tally')
  const imports = importsOf(moduleAppend)
  const zoneAppend = callsIn(zone, /^append\w*$/)
  const glue = [...imports].filter(([, url]) => /extra\.tree$/.test(url)).map(([name]) => name)

  ok('module-append: the zone calls the dom\'s append', zoneAppend.length === 2 && zoneAppend.every(name => /dom\/native\/memory\/dom\.tree$/.test(imports.get(name) ?? '')), zoneAppend.join(', '))
  ok('module-append: the module\'s own append is imported under another name', glue.length === 1 && !zoneAppend.includes(glue[0]!), glue.join(', '))
  ok('module-append: the module\'s own append is called by the entry\'s own call', glue.length === 1 && callsIn(moduleAppend, /^append\w*$/).includes(glue[0]!), moduleAppend.slice(-800))
}

const entryScope = codes.get('entry-scope')

if (entryScope !== undefined) {
  const imports = importsOf(entryScope)
  const epilogue = entryScope.slice(entryScope.indexOf('if (hot) {\n  hot.dispose'))
  const removes = callsIn(epilogue, /^remove\w*$/)
  const scopes = callsIn(bodyOf(entryScope, 'tally'), /^openScope\w*$/)

  ok('entry-scope: the entry keeps its own remove and open-scope', definesIn(entryScope).has('remove') && definesIn(entryScope).has('openScope'))
  ok('entry-scope: the epilogue removes through the dom\'s remove, not the entry\'s', removes.length === 1 && removes[0] !== 'remove' && isRuntimeFile(imports.get(removes[0]!) ?? ''), removes.join(', '))
  ok('entry-scope: the zone opens its scope through the runtime\'s, not the entry\'s', scopes.length === 1 && scopes[0] !== 'openScope' && isRuntimeFile(imports.get(scopes[0]!) ?? ''), scopes.join(', '))
}

console.log(`view-module-split: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
