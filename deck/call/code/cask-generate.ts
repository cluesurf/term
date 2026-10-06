// The cask bridge generator: from the public signatures of every native-backed module a page docks, mint the
// `webview` env shim for that module and the app's dispatcher with its allowlist. Nobody writes the seam twice and
// nobody keeps two copies in step. `term make --target <platform>` runs it before every build; `pnpm term:cask-generate`
// runs it alone, and with --check holds what is on disk to it. Item cask-0005; the shape is the one cask-0004 wrote by
// hand, grown for cask-0012 to carry opaque handles and lists.
//
// A module with a native half is one whose page-side resolution lands on `<package>/code/**/native/node/<name>.tree`:
// the stdlib's `file`, the site framework's `base/db`, any package that follows the layout. Its signatures come from
// the PUBLIC module (`<package>/code/**/<name>.tree`) when that declares tasks that forward to the native, and from
// the ABSTRACT module beside the env directories (`.../native/<name>.tree`) when the public module only `bear`s it.
//
// Two outputs per run:
//   <package>/code/**/native/webview/<name>.tree   the shim: each native task as one command over the bridge
//   <out>/dispatch.tree                            the cask side: `is-allowed`, `run-command`, `dispatch`
//
// What crosses: text, boolean, number, decimal, nothing (void), an OPAQUE HANDLE (a form whose one field is a
// private `handle`: the value stays in the cask under a tone-code id and the page holds the id), a RECORD by value
// (native-dom-0019: a form declared in a module of its own, its fields scalars, lists or records, carried as host
// data text through `melt` and `fill`, so a missing field is the named `data-mismatch`), BYTES (as base64 text, through
// @term/base/bytes on both sides), and a LIST of any of those. A record the module declares itself, and a task that
// takes a function, do not cross; such a task is emitted as a raise naming the reason, or run in the page where the page
// has the module too, so the module still builds and the gap is visible rather than silent. Design:
// note/term/cask/readme.md.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { expandTemplates } from '@term/make/code/compile/template'
import { collectModules } from '@term/make/code/compile/load'
import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'
import { projectResolver } from '@term/call/code/make'
import { stdlibBase } from '@term/make/code/resolve'
import { CAPABILITIES, capabilityOf, readScope } from '@term/call/code/scope'
// a function, read when a bridge is generated, so the two modules loading each other is harmless
import { appIdentity } from '@term/call/code/cask'
import type { Access, Scope } from '@term/call/code/scope'

// the commands every cask answers on its own behalf, in the order the dispatcher lists them
// `cask_release` lets a handle go: the page sends it when it has dropped one (bridge.ts, a FinalizationRegistry), so a
// value the cask holds for a page lives exactly as long as the page holds its id (native-dom-0017)
const CASK_COMMANDS = ['cask_bundle_path', 'cask_data_path', 'cask_exit', 'cask_quit', 'cask_log', 'cask_release'] as const

// the modules the shim itself is written with, which therefore never cross
const NEVER_CROSS = new Set(['json', 'float', 'uuid'])

// the modules that cross even though the page could serve them: their browser impl is a sandbox stand-in (OPFS for
// `file`, an empty environment, a process that is a tab), and inside a cask the process is the truth
const CROSS_ANYWAY = new Set(['file', 'environment', 'process'])

// the device capabilities of `@term/site/view` (device-layer-0013), which cross for the same reason: a WebView offers a
// subset of each (no torch, no haptics, no battery in WKWebView), and the cask's process reaches the platform's own API
// through the toolkit host. Matched with their package and folder, so another package's `open` or `network` is not
// caught. A task of one that cannot cross (a watcher, which takes a handler) stays in the page, on the browser host
const DEVICE = new Set(['permission', 'camera', 'microphone', 'contacts', 'calendar', 'photos', 'torch', 'location', 'clipboard', 'vibration', 'notification', 'open', 'battery', 'network', 'motion', 'secret', 'biometric'])

// the env directories the page's own build can serve a module from: `webview` borrows `browser`, and the
// javascript-wide impls serve every javascript env
const PAGE_ENVS = ['webview', 'browser', 'javascript', 'shared']

// the env directories a cask's process can serve a module from
const CASK_ENVS = ['swift', 'kotlin', 'rust']

type Kind =
  | { kind: 'text' | 'boolean' | 'number' | 'decimal' | 'void' }
  // bytes cross as base64 text, written and read with @term/base/bytes on both sides, so an image or a file's raw
  // contents reach the cask and come back whole
  | { kind: 'bytes' }
  // a value declared `like unknown` or `like dynamic`: it crosses AS its json, so a text, a number, a boolean or
  // null, which is what a database parameter is. A record here would arrive as a json object, not a Term record
  | { kind: 'dynamic' }
  | { kind: 'handle'; form: string }
  | { kind: 'list'; item: Kind }
  // a RECORD crosses by value (native-dom-0019): written as host data on one side (`melt`, then `write`) and filled
  // back into the form on the other (`read`, then `fill`), so both ends use the walker the compiler generates for the
  // form on every backend, and a field missing or of the wrong kind raises the named `data-mismatch` with its path.
  // `from` is the module that declares the form, which the shim and the dispatcher both load it from
  | { kind: 'record'; form: string; from: string }

type Param = { name: string; kind: Kind }

type RecordType = Extract<Statement, { form: 'record-type' }>

// one public task of a module, and the native task it forwards to
type Signature = {
  module: string
  task: string
  native: string
  params: Param[]
  result: Kind
  async: boolean
}

// a public task the bridge cannot carry yet, with the reason
type Refused = { module: string; task: string; native: string; params: { name: string }[]; reason: string }

// a module with a native half, found through the page's closure
type Module = {
  name: string
  // the `load` path a program writes for the public module: `@term/site/base/postgres`
  importPath: string
  // the public module, the abstract module beside the env directories when it exists, and where the shim goes
  publicFile: string
  abstractFile?: string
  shimFile: string
  // the env beside the shim that also serves the module in the page, which a task that cannot cross forwards to
  // rather than raising: a device module's watchers run on the browser host
  pageEnv?: string
}

// ---- reading the program ----

function programOf(file: string, term: string): Program {
  const parsed = parse({ file, text: readFileSync(file, 'utf8') })

  if (!parsed.ok) {
    throw new Error(`${relative(term, file)} does not parse: ${parsed.diagnostics[0]?.message}`)
  }

  const built = mill(expandTemplates(parsed.tree), file)

  if (!built.ok) {
    throw new Error(`${relative(term, file)} does not mill: ${built.diagnostics[0]?.message}`)
  }

  return built.program
}

// every name a module `find`s, with the files it resolves to, as the build resolves them for node
function importedNames(file: string, term: string): Map<string, string[]> {
  const collected = collectModules({ file, text: readFileSync(file, 'utf8') }, projectResolver(term, 'node'))
  const own = collected.scope?.get(file) ?? [...(collected.scope?.entries() ?? [])].find(([key]) => realOf(key) === realOf(file))?.[1]

  return own?.finds ?? new Map()
}

const realOf = (file: string): string => (existsSync(file) ? realpathSync(file) : file)

// the load path a program writes for a file: `<...>/deck/<package>/code/<rest>.tree` is `@term/<package>/<rest>`, the
// short form, since a package path resolves inside the package's code root first
// (note/term/plan/manifest-mark-and-code-root.md)
function importPathOf(file: string): string | undefined {
  const match = /\/deck\/([^/]+)\/code\/(.+)\.tree$/.exec(realOf(file))

  return match ? `@term/${match[1]}/${match[2]}` : undefined
}

// a form whose one field is a private `handle` is an opaque handle: the value stays in the cask, the page holds an id
function isHandleForm(form: RecordType): boolean {
  return form.fields.length === 1 && form.fields[0]!.name === 'handle' && form.variants.length === 0
}

// the forms a module can name, and for each one IMPORTED, the load path of the module that declares it. A form
// declared in the public or abstract module itself has no `from`: the shim cannot load the module that bears it
type Forms = { declared: Map<string, RecordType>; from: Map<string, string> }

// the field kinds `fill` and `melt` carry: scalars, lists of them, and nested records
function crossesByValue(kind: Kind): boolean {
  switch (kind.kind) {
    case 'text':
    case 'boolean':
    case 'number':
    case 'decimal':
    case 'record':
      return true
    case 'list':
      return crossesByValue(kind.item)
    default:
      return false
  }
}

function kindOf(type: Type | undefined, forms: Forms, seen: Set<string> = new Set()): Kind | { refuse: string } {
  if (!type) {
    return { kind: 'void' }
  }

  switch (type.kind) {
    case 'string':
      return { kind: 'text' }
    case 'boolean':
      return { kind: 'boolean' }
    case 'number':
      return { kind: 'number' }
    case 'float':
      return { kind: 'decimal' }
    case 'unit':
      return { kind: 'void' }
    case 'array': {
      const item = kindOf(type.element, forms, seen)

      if ('refuse' in item) {
        return { refuse: `a list of ${item.refuse}` }
      }

      if (item.kind === 'void') {
        return { refuse: 'a list of nothing' }
      }

      return { kind: 'list', item }
    }
    case 'named': {
      const form = forms.declared.get(type.name)

      if (form && isHandleForm(form)) {
        return { kind: 'handle', form: type.name }
      }

      if (!form) {
        return { refuse: `type ${type.name}` }
      }

      const from = forms.from.get(type.name)

      if (!from) {
        return { refuse: `record ${type.name}, declared in the module itself: declare it in a module of its own, which both sides load` }
      }

      if (form.variants.length > 0 || form.params.length > 0 || (type.args?.length ?? 0) > 0) {
        return { refuse: `record ${type.name}, which has variants or type parameters` }
      }

      if (seen.has(type.name)) {
        return { refuse: `record ${type.name}, which holds itself` }
      }

      for (const field of form.fields) {
        const inner = kindOf(field.type, forms, new Set([...seen, type.name]))

        if ('refuse' in inner) {
          return { refuse: `record ${type.name}, whose field ${field.name} is ${inner.refuse}` }
        }

        if (!crossesByValue(inner)) {
          return { refuse: `record ${type.name}, whose field ${field.name} is a ${inner.kind}, which a record cannot carry` }
        }
      }

      return { kind: 'record', form: type.name, from }
    }
    case 'unknown':
    case 'dynamic':
      return { kind: 'dynamic' }
    case 'bytes':
      return { kind: 'bytes' }
    case 'variable':
      return { refuse: 'an element left to inference, so write its type' }
    default:
      return { refuse: type.kind }
  }
}

// the first call in a body, which in a public module is the forward to the native task
function forwardedTo(body: Statement[]): string | undefined {
  for (const statement of body) {
    const found = callIn(statement)

    if (found) {
      return found
    }
  }

  return undefined
}

function callIn(node: Statement | Expression): string | undefined {
  if (node.form === 'call') {
    const callee = node.callee

    return callee.form === 'variable' ? callee.name : undefined
  }

  if (node.form === 'return' && node.value) {
    return callIn(node.value)
  }

  if (node.form === 'let' && 'value' in node && node.value) {
    return callIn(node.value as Expression)
  }

  return undefined
}

// every task the bridge carries for a module, split from what it refuses. The public module's tasks when it has
// them, else the abstract module's, whose task names are the native names too
function signaturesOf(module: Module, term: string): { carried: Signature[]; refused: Refused[] } {
  const publicProgram = programOf(module.publicFile, term)
  const abstractProgram = module.abstractFile ? programOf(module.abstractFile, term) : []
  const forms: Forms = { declared: new Map(), from: new Map() }

  for (const statement of [...publicProgram, ...abstractProgram]) {
    if (statement.form === 'record-type') {
      forms.declared.set(statement.name, statement)
    }
  }

  // the forms the public module imports by name, each read from the file that declares it (native-dom-0019)
  for (const [name, files] of importedNames(module.publicFile, term)) {
    for (const file of files) {
      const declared = programOf(file, term).find(
        (s): s is RecordType => s.form === 'record-type' && s.name === name,
      )
      const path = importPathOf(file)

      if (declared && path && !forms.declared.has(name)) {
        forms.declared.set(name, declared)
        forms.from.set(name, path)
      }
    }
  }

  const publicTasks = publicProgram.filter(
    (s): s is Extract<Statement, { form: 'function' }> => s.form === 'function' && !s.private,
  )
  const source = publicTasks.length > 0 ? publicTasks : abstractProgram.filter(
    (s): s is Extract<Statement, { form: 'function' }> => s.form === 'function' && !s.private,
  )
  const forwards = publicTasks.length > 0

  const carried: Signature[] = []
  const refused: Refused[] = []

  for (const statement of source) {
    const native = forwards ? forwardedTo(statement.body) : statement.name

    if (!native) {
      continue
    }

    const params: Param[] = []
    let reason: string | undefined

    for (const param of statement.params) {
      const kind = kindOf(param.type, forms)

      if ('refuse' in kind) {
        reason = `parameter ${param.name} is ${kind.refuse}`
        break
      }

      if (kind.kind === 'void') {
        reason = `parameter ${param.name} is nothing`
        break
      }

      params.push({ name: param.name, kind })
    }

    const result = kindOf(statement.result, forms)

    if (!reason && 'refuse' in result) {
      reason = `result is ${result.refuse}`
    }

    // the dispatcher names each task `<module>-<task>`, and names are package-global: a record form of the same
    // name would be shadowed by the alias in the one program that needs both
    if (!reason && !('refuse' in result)) {
      const clash = recordForms([{ module: module.name, task: statement.name, native, params, result, async: false }])
        .find(({ form }) => source.some(task => `${module.name}-${task.name}` === form))

      if (clash) {
        reason = `record ${clash.form} has the name the dispatcher gives the task ${clash.form.slice(module.name.length + 1)}: rename the form`
      }
    }

    if (reason || 'refuse' in result) {
      refused.push({
        module: module.name,
        task: statement.name,
        native,
        params: statement.params.map(p => ({ name: p.name })),
        reason: reason ?? 'unknown',
      })
      continue
    }

    carried.push({ module: module.name, task: statement.name, native, params, result, async: Boolean(statement.async) })
  }

  return { carried, refused }
}

// a generated shim for a module that no longer crosses (the rule moved, or the module grew a page-side impl). The
// generator never deletes a file, so it rewrites the shim to forward to the env the page serves the module from,
// and reports it for removal by hand
type Orphan = { shimFile: string; forward: string }

// the modules the page reaches that have a native half: the closure resolved for node names them by their node
// native, and the layout names the rest
function dockedModules(page: string, root: string): { modules: Module[]; orphans: Orphan[] } {
  const sources = collectModules(
    { file: page, text: readFileSync(page, 'utf8') },
    projectResolver(root, 'node'),
  ).sources

  const found = new Map<string, Module>()
  const orphans: Orphan[] = []
  // `<package root>/code/<...>/native/node/<name>.tree`, wherever the package was resolved from, or the abstract
  // module beside the env directories (`native/<name>.tree`) when node resolved to that (a module in Term all the
  // way down, with no native anywhere)
  const native = /^(.*\/deck\/([^/]+)\/code(?:\/(.*?))?)\/native\/(?:node\/)?([^/]+)\.tree$/

  for (const source of sources) {
    const real = existsSync(source.file) ? realpathSync(source.file) : source.file
    const match = native.exec(real)

    if (!match) {
      continue
    }

    const [, codeDir, packageName, under, name] = match

    // one level only for now: `file`, not `file/asynchronous`. The nested families come with bytes and records
    if (name!.includes('/') || NEVER_CROSS.has(name!)) {
      continue
    }

    const publicFile = join(codeDir!, `${name}.tree`)

    if (!existsSync(publicFile)) {
      continue
    }

    // a module crosses when the cask can serve it and the page cannot, or when the page's impl is a stand-in. A
    // module the page serves itself (dom, graphics, the pure ones) stays in the page. A webview shim somebody
    // wrote by hand (the cask's own) is theirs, not the generator's
    const shimFile = join(codeDir!, 'native', 'webview', `${name}.tree`)
    const has = (env: string): boolean => existsSync(join(codeDir!, 'native', env, `${name}.tree`))
    const generated = has('webview') && readFileSync(shimFile, 'utf8').includes('GENERATED by term make')
    const pageServes = PAGE_ENVS.some(env => env === 'webview' ? has(env) && !generated : has(env))
    // a module with no native at all but an abstract module beside the env directories (`native/local.tree`) is
    // Term all the way down: every cask env resolves to it, so the cask serves it too
    const caskServes = CASK_ENVS.some(has) || existsSync(join(codeDir!, 'native', `${name}.tree`))
    const device = packageName === 'site' && under === 'view' && DEVICE.has(name!)

    if (!caskServes || (pageServes && !CROSS_ANYWAY.has(name!) && !device)) {
      const served = PAGE_ENVS.find(env => env !== 'webview' && has(env))

      if (generated && served) {
        orphans.push({ shimFile, forward: `../${served}/${name}` })
      }

      continue
    }

    const abstractFile = join(codeDir!, 'native', `${name}.tree`)
    const importPath = `@term/${packageName}/${under ? `${under}/` : ''}${name}`

    found.set(importPath, {
      name: name!,
      importPath,
      publicFile,
      abstractFile: existsSync(abstractFile) ? abstractFile : undefined,
      shimFile,
      pageEnv: device && has('browser') ? 'browser' : undefined,
    })
  }

  return { modules: [...found.values()].sort((a, b) => a.importPath.localeCompare(b.importPath)), orphans }
}

function orphanText(orphan: Orphan): string {
  return [
    '',
    '# GENERATED by term make, and no longer needed: the page serves this module itself, so nothing crosses the',
    '# bridge for it. This file only forwards to that impl so a build that still finds it here is right. Delete it.',
    '',
    `bear ${orphan.forward}`,
    '',
  ].join('\n')
}

// ---- writing tree ----

const commandOf = (signature: Signature): string => `${signature.module}_${signature.task}`.replaceAll('-', '_')

// the name of the cask's table for a handle form: `row-handles`
const tableOf = (form: string): string => `${form}-handles`

// whether any parameter or result of these signatures carries bytes, directly or in a list: then both sides load the
// base64 pair, under names no module's own task can take
const holdsBytes = (kind: Kind): boolean => kind.kind === 'bytes' || (kind.kind === 'list' && holdsBytes(kind.item))
const BYTES_LOADS = ['load @term/base/bytes', '  find to-base64, name bytes-to-base64', '  find from-base64, name bytes-from-base64', '']
const bytesLoads = (signatures: Signature[]): string[] =>
  signatures.some(one => holdsBytes(one.result) || one.params.some(param => holdsBytes(param.kind))) ? BYTES_LOADS : []

function likeOf(kind: Kind): string[] {
  switch (kind.kind) {
    case 'text':
      return ['like text']
    case 'boolean':
      return ['like boolean']
    case 'number':
      return ['like number']
    case 'decimal':
      return ['like decimal']
    case 'void':
      return ['like void']
    case 'handle':
      return [`like ${kind.form}`]
    case 'dynamic':
      return ['like unknown']
    case 'bytes':
      return ['like bytes']
    case 'list':
      return ['like list', ...likeOf(kind.item).map(line => `  ${line}`)]
    case 'record':
      return [`like ${kind.form}`]
  }
}

const INVOKE: Record<Exclude<Kind, { kind: 'list' | 'handle' | 'dynamic' | 'record' | 'bytes' }>['kind'], string> = {
  text: 'invoke-text',
  boolean: 'invoke-boolean',
  number: 'invoke-number',
  decimal: 'invoke-decimal',
  void: 'invoke-void',
}

// a fresh local name per emitted temporary
let temporaries = 0
const temporary = (base: string): string => `${base}-${(temporaries += 1)}`

// STATEMENTS that leave a json value of `read` in a local, and the local's name. The page side of the seam: what a
// Term value of this kind is as json. Scalars are one call; a handle is its id; a list walks its items
function pageToJson(kind: Kind, read: string, indent: string): { lines: string[]; local: string } {
  const local = temporary('json')

  switch (kind.kind) {
    case 'text':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call from-text`, `${indent}    read ${read}`] }
    case 'boolean':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call from-boolean`, `${indent}    read ${read}`] }
    case 'number':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call from-number`, `${indent}    call to-decimal`, `${indent}      read ${read}`] }
    case 'decimal':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call from-number`, `${indent}    read ${read}`] }
    case 'void':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call make-null`] }
    case 'dynamic':
      return { local, lines: [`${indent}save ${local}`, `${indent}  read ${read}`] }
    case 'bytes':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call from-text`, `${indent}    call bytes-to-base64`, `${indent}      read ${read}`] }
    case 'handle':
      // the page holds the id in the form's private field
      return { local, lines: [`${indent}save ${local}`, `${indent}  call from-text`, `${indent}    read ${read}/handle`] }
    case 'record':
      // the record as host data text: melt walks the form's fields, write lays the data out
      return {
        local,
        lines: [
          `${indent}save ${local}`,
          `${indent}  call from-text`,
          `${indent}    call data-to-text`,
          `${indent}      call melt`,
          `${indent}        read ${read}`,
          `${indent}        like ${kind.form}`,
        ],
      }
    case 'list': {
      const item = temporary('item')
      const inner = pageToJson(kind.item, item, `${indent}    `)

      return {
        local,
        lines: [
          `${indent}save ${local}`,
          `${indent}  call make-array`,
          `${indent}walk list, read ${read}`,
          `${indent}  hook next`,
          `${indent}    take site, name ${item}`,
          ...inner.lines,
          `${indent}    save ${local}`,
          `${indent}      call push-item`,
          `${indent}        read ${local}`,
          `${indent}        read ${inner.local}`,
        ],
      }
    }
  }
}

// STATEMENTS that leave a Term value of this kind in a local, from the json in `read`. The page side receiving a reply
function pageFromJson(kind: Kind, read: string, indent: string): { lines: string[]; local: string } {
  const local = temporary('value')

  switch (kind.kind) {
    case 'text':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call as-text`, `${indent}    read ${read}`] }
    case 'boolean':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call as-boolean`, `${indent}    read ${read}`] }
    case 'number':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call to-number`, `${indent}    call as-number`, `${indent}      read ${read}`] }
    case 'decimal':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call as-number`, `${indent}    read ${read}`] }
    case 'void':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call make-null`] }
    case 'dynamic':
      return { local, lines: [`${indent}save ${local}`, `${indent}  read ${read}`] }
    case 'bytes':
      return { local, lines: [`${indent}save ${local}`, `${indent}  call bytes-from-base64`, `${indent}    call as-text`, `${indent}      read ${read}`] }
    case 'handle':
      return {
        local,
        lines: [
          `${indent}save ${local}`,
          `${indent}  make ${kind.form}`,
          `${indent}    bind handle`,
          `${indent}      call as-text`,
          `${indent}        read ${read}`,
          // held: when the page drops this value and the WebView collects it, the cask is told to drop its own
          `${indent}call bridge/held`,
          `${indent}  text <${kind.form}>`,
          `${indent}  read ${local}`,
          `${indent}  call as-text`,
          `${indent}    read ${read}`,
        ],
      }
    case 'list':
      return listFromJson(kind.item, read, indent, pageFromJson)
    case 'record':
      // the host data text read back and filled into the form: a field missing, or of the wrong kind, raises
      // `data-mismatch` naming its path, which the dispatcher answers as the exception and the page's call rejects with
      return {
        local,
        lines: [
          `${indent}save ${local}`,
          `${indent}  call fill`,
          `${indent}    call data-from-text`,
          `${indent}      call as-text`,
          `${indent}        read ${read}`,
          `${indent}    like ${kind.form}`,
        ],
      }
  }
}

// every record form a set of signatures mentions, with the module each is loaded from
function recordForms(signatures: Signature[]): { form: string; from: string }[] {
  const forms = new Map<string, string>()
  const visit = (kind: Kind): void => {
    if (kind.kind === 'record') {
      forms.set(kind.form, kind.from)
    } else if (kind.kind === 'list') {
      visit(kind.item)
    }
  }

  for (const signature of signatures) {
    signature.params.forEach(p => visit(p.kind))
    visit(signature.result)
  }

  return [...forms].sort(([a], [b]) => a.localeCompare(b)).map(([form, from]) => ({ form, from }))
}

// the loads a program carrying records needs: each form from its own module, and the host dialect's reader and
// writer under names no program around them would use
function recordLoads(records: { form: string; from: string }[]): string[] {
  if (records.length === 0) {
    return []
  }

  return [
    ...records.flatMap(({ form, from }) => [`load ${from}`, `  find ${form}`, '']),
    // under names of their own, never aliases: the dispatcher imports `file` too, whose `read` and `write` share their
    // names with the host dialect's, and an alias is rewritten to the original name inside its file
    'load @term/host/base',
    '  find data',
    '',
    'load @term/host/text',
    '  find data-from-text',
    '  find data-to-text',
    '',
  ]
}

// a list from a json array: the items as a list, then each one converted. A list of dynamic is the items as they are
function listFromJson(item: Kind, read: string, indent: string, one: typeof pageFromJson): { lines: string[]; local: string } {
  const local = temporary('value')
  const items = temporary('items')

  if (item.kind === 'dynamic') {
    return { local, lines: [`${indent}save ${local}`, `${indent}  call ${itemsOf}`, `${indent}    read ${read}`] }
  }

  const each = temporary('item')
  const inner = one(item, each, `${indent}    `)

  return {
    local,
    lines: [
      `${indent}save ${items}`,
      `${indent}  call ${itemsOf}`,
      `${indent}    read ${read}`,
      `${indent}save ${local}`,
      `${indent}  make list`,
      `${indent}walk list, read ${items}`,
      `${indent}  hook next`,
      `${indent}    take site, name ${each}`,
      ...inner.lines,
      `${indent}    call push`,
      `${indent}      bind list, read ${local}`,
      `${indent}      bind item, read ${inner.local}`,
    ],
  }
}

// the cask side: a Term value from the json in `read`. A handle id is looked up in the cask's table for its form
function caskFromJson(kind: Kind, read: string, indent: string): { lines: string[]; local: string } {
  const local = temporary('value')

  switch (kind.kind) {
    case 'handle': {
      // an id the table lacks is a page holding a handle the cask never gave it: `unwrap` raises
      const found = temporary('found')
      const id = temporary('id')

      return {
        local,
        lines: [
          // a released id is one the table no longer holds, so `unwrap` refuses it with the stdlib `absence`, the
          // same as a forged one. The page's call rejects and the cask keeps running. Looked up under THIS window's
          // key (native-dom-0030): an id another window's page was given is not in this window's part of the table,
          // so it is refused the same way
          `${indent}save ${id}`,
          `${indent}  call as-text`,
          `${indent}    read ${read}`,
          `${indent}save ${found}`,
          `${indent}  call get`,
          `${indent}    read ${tableOf(kind.form)}`,
          `${indent}    text <{{owner}}/{{${id}}}>`,
          `${indent}save ${local}`,
          `${indent}  call unwrap`,
          `${indent}    read ${found}`,
        ],
      }
    }
    case 'list':
      return listFromJson(kind.item, read, indent, caskFromJson)
    default:
      return pageFromJson(kind, read, indent)
  }
}

// the cask side: json from a Term value. A handle is kept in the table under a fresh id and the id crosses
function caskToJson(kind: Kind, read: string, indent: string): { lines: string[]; local: string } {
  const local = temporary('json')

  switch (kind.kind) {
    case 'handle': {
      const id = temporary('id')

      return {
        local,
        lines: [
          // kept under the window that asked (native-dom-0030); the page gets the id alone
          `${indent}save ${id}`,
          `${indent}  call version4`,
          `${indent}call set`,
          `${indent}  read ${tableOf(kind.form)}`,
          `${indent}  text <{{owner}}/{{${id}}}>`,
          `${indent}  read ${read}`,
          `${indent}save ${local}`,
          `${indent}  call from-text`,
          `${indent}    read ${id}`,
        ],
      }
    }
    case 'list': {
      const item = temporary('item')
      const inner = caskToJson(kind.item, item, `${indent}    `)

      return {
        local,
        lines: [
          `${indent}save ${local}`,
          `${indent}  call make-array`,
          `${indent}walk list, read ${read}`,
          `${indent}  hook next`,
          `${indent}    take site, name ${item}`,
          ...inner.lines,
          `${indent}    save ${local}`,
          `${indent}      call push-item`,
          `${indent}        read ${local}`,
          `${indent}        read ${inner.local}`,
        ],
      }
    }
    default:
      return pageToJson(kind, read, indent)
  }
}

// the task that turns a json array into a list of its items, one per program: the checker learns a list's element
// from a declared signature, where a `make list` fed dynamic items would leave it to inference
function itemsOfText(name: string): string[] {
  return [
    '# the items of a json array, as a list whose element the checker knows',
    `task ${name}`,
    '  take array, like dynamic',
    '  like list',
    '    like unknown',
    '  save items',
    '    make list',
    '  walk size',
    '    bind base, code 0',
    '    bind head',
    '      call array-size',
    '        read array',
    '    hook next',
    '      take site, name index',
    '      # declared unknown, so a backend that boxes its dynamic boxes it here',
    '      save item',
    '        like unknown',
    '        call get-item',
    '          read array',
    '          read index',
    '      call push',
    '        bind list, read items',
    '        bind item, read item',
    '  send back, read items',
    '',
  ]
}

// the name of that task in the program being written: the shim's is per module, since a page docks many
let itemsOf = 'items-of'

// every handle form a set of signatures mentions
function handleForms(signatures: Signature[]): string[] {
  const forms = new Set<string>()
  const visit = (kind: Kind): void => {
    if (kind.kind === 'handle') {
      forms.add(kind.form)
    } else if (kind.kind === 'list') {
      visit(kind.item)
    }
  }

  for (const signature of signatures) {
    signature.params.forEach(p => visit(p.kind))
    visit(signature.result)
  }

  return [...forms].sort()
}

const JSON_FINDS = [
  'make-object', 'set-field', 'from-text', 'from-boolean', 'from-number', 'make-null',
  'as-text', 'as-boolean', 'as-number', 'make-array', 'push-item', 'get-item', 'array-size',
]

// the lifetime verb: a task named `release` that takes exactly one handle and answers nothing. It is not a command:
// the page lets the handle go through `bridge/release`, which tells the cask to drop it from its table, and the
// native task it names (a no-op wherever a handle is a plain value) never runs (native-dom-0029)
function isRelease(signature: Signature): boolean {
  return (
    signature.task === 'release' &&
    signature.params.length === 1 &&
    signature.params[0]!.kind.kind === 'handle' &&
    signature.result.kind === 'void'
  )
}

function shimText(module: Module, carried: Signature[], refused: Refused[], term: string): string {
  temporaries = 0
  const lines: string[] = [
    '',
    `# GENERATED by term make from ${relative(term, module.publicFile)}. Do not edit; regenerate with`,
    `# \`term make --target <platform>\` or \`pnpm term:cask-generate --page <page> --commit\`.`,
    '#',
    `# The \`${module.name}\` module from inside a cask's page. Every task is one command over the bridge to the cask, which`,
    `# runs the same public task in the env that is native there. The command name is the public module, an`,
    `# underscore, the public task, with hyphens as underscores. An opaque handle stays in the cask and crosses as its`,
    `# id, which the page keeps in the form's private field. Internal: reached only through the public ${module.name} API.`,
    '',
    'dock load',
    '  load <global:bridge>, name bridge',
    '',
    'load @term/base/json',
    ...JSON_FINDS.map(name => `  find ${name}`),
    '',
    'load @term/base/float',
    '  find to-decimal',
    '  find to-number',
    '',
    'load @term/base/list',
    '  find list',
    '  find push',
    '',
    ...bytesLoads(carried),
    ...recordLoads(recordForms(carried)),
  ]

  for (const form of handleForms(carried)) {
    lines.push(`# an opaque handle: the id of a value the cask holds`, `form ${form}`, '  link handle, mark private', '')
  }

  itemsOf = `${module.name}-items-of`
  lines.push(...itemsOfText(itemsOf))

  for (const signature of carried) {
    if (isRelease(signature)) {
      const param = signature.params[0]!
      const form = (param.kind as { kind: 'handle'; form: string }).form
      lines.push(
        `# let ${param.name} go now: the cask drops it from its table, and a use after this is refused`,
        `task ${signature.native}`,
        '  mark async',
        `  take ${param.name}`,
        ...likeOf(param.kind).map(line => `    ${line}`),
        // waited for: the cask's reply is what orders the release before the next call using the handle
        '  call bridge/release',
        '    wait true',
        `    text <${form}>`,
        `    read ${param.name}`,
        `    read ${param.name}/handle`,
        '',
      )
      continue
    }

    lines.push(`task ${signature.native}`, '  mark async')

    for (const param of signature.params) {
      lines.push(`  take ${param.name}`, ...likeOf(param.kind).map(line => `    ${line}`))
    }

    lines.push(...likeOf(signature.result).map(line => `  ${line}`))

    // the arguments object, one field per parameter
    lines.push('  save arguments', '    call make-object')

    for (const param of signature.params) {
      const json = pageToJson(param.kind, param.name, '  ')
      lines.push(...json.lines, '  save arguments', '    call set-field', '      read arguments', `      text <${param.name}>`, `      read ${json.local}`)
    }

    const result = signature.result

    if (result.kind === 'list' || result.kind === 'handle' || result.kind === 'dynamic' || result.kind === 'record' || result.kind === 'bytes') {
      lines.push('  save reply', '    call bridge/invoke', '      wait true', `      text <${commandOf(signature)}>`, '      read arguments')
      const value = pageFromJson(result, 'reply', '  ')
      lines.push(...value.lines, `  send back, read ${value.local}`)
    } else if (result.kind === 'void') {
      lines.push(`  call bridge/${INVOKE[result.kind]}`, '    wait true', `    text <${commandOf(signature)}>`, '    read arguments')
    } else if (module.pageEnv && result.kind === 'text') {
      // the cask's answer, unless it has none: a cask with no device host (Linux and Windows, built for bare rust)
      // answers `unhosted` (its dispatcher's `device-answer`), and the WebView may have the capability itself
      // (WebView2's clipboard, geolocation and camera), so the page's own host is asked then. A host's own
      // `unavailable` (no torch on a Mac, no CAMERA declared on Android) is the answer, and is not asked again
      lines.push(
        '  save reply',
        `    call bridge/${INVOKE[result.kind]}`,
        '      wait true',
        `      text <${commandOf(signature)}>`,
        '      read arguments',
        '  fork test',
        '    hook test',
        '      call is-equal',
        '        read reply',
        '        text <unhosted>',
        '    hook hold',
        '      send back',
        `        call page-${signature.native}`,
        ...signature.params.map(param => `          read ${param.name}`),
        '  send back, read reply',
      )
    } else {
      lines.push('  send back', `    call bridge/${INVOKE[result.kind]}`, '      wait true', `      text <${commandOf(signature)}>`, '      read arguments')
    }

    lines.push('')
  }

  // where the page has the module too: a task that cannot cross runs there, and a text answer the cask has none for is
  // asked of it, each through that env's own task
  const asked = module.pageEnv
    ? [...carried.filter(one => !isRelease(one) && one.result.kind === 'text').map(one => one.native), ...refused.map(one => one.native)]
    : []

  if (asked.length > 0) {
    lines.splice(
      lines.indexOf('dock load'),
      0,
      `load ../${module.pageEnv}/${module.name}`,
      ...asked.map(native => `  find ${native}, name page-${native}`),
      '',
    )
  }

  for (const one of refused) {
    if (module.pageEnv) {
      lines.push(`# not carried (${one.reason}): it runs in the page, on the ${module.pageEnv} host`, `task ${one.native}`)

      for (const param of one.params) {
        lines.push(`  take ${param.name}, like unknown`)
      }

      lines.push('  like unknown', '  send back', `    call page-${one.native}`, ...one.params.map(param => `      read ${param.name}`), '')
      continue
    }

    lines.push(`# not carried: ${one.reason}`, `task ${one.native}`, '  mark async')

    for (const param of one.params) {
      lines.push(`  take ${param.name}, like unknown`)
    }

    lines.push('  like unknown', `  halt <${one.module}/${one.task} does not cross the cask bridge yet: ${one.reason}>`, '')
  }

  return lines.join('\n')
}

// `cask_release`: drop the value under `handle` from the table of `form`. A released id is then one the cask never gave
// out, so a page that uses it after letting it go is refused by `unwrap`, the same as a forged one
function releaseLines(forms: string[]): string[] {
  const lines = ['    hook test', '      call is-equal', '        read command', '        text <cask_release>', '    hook hold']

  if (forms.length > 0) {
    // the id under this window's key: a page can let go only of what its own window holds (native-dom-0030)
    lines.push('      save released', '        call field-text', '          read arguments', '          text <handle>', '      fork test')

    for (const form of forms) {
      lines.push(
        '        hook test',
        '          call is-equal',
        '            call field-text',
        '              read arguments',
        '              text <form>',
        `            text <${form}>`,
        '        hook hold',
        // the map primitive on the table, the one every backend lowers (`hash/remove` is written over it). A bare
        // `remove` resolved to whichever one-argument `remove` the scope held, and `/remove` is not lowered on Swift
        `          call ${tableOf(form)}/delete`,
        '            text <{{owner}}/{{released}}>',
      )
    }

    lines.push('        hook miss', '          save skip, code 0')
  }

  lines.push('      send back', '        call make-null')

  return lines
}

// `drop-window`'s body: every handle in every table kept under the window's key, deleted. The keys are listed first,
// so the deletes do not change what is being walked
function dropLines(forms: string[]): string[] {
  if (forms.length === 0) {
    return ['  save skip, code 0']
  }

  const lines = ['  save prefix, text <{{owner}}/>']

  for (const form of forms) {
    // the keys into a local first: a walk straight over the call's result is not a list Swift can iterate
    const keys = `${form}-keys`
    lines.push(
      `  save ${keys}`,
      '    like list',
      '      like text',
      `    call ${tableOf(form)}/keys`,
      '  walk list',
      `    read ${keys}`,
      '    hook next',
      '      take site, name held',
      '      fork test',
      '        hook test',
      '          call starts-with',
      '            read held',
      '            read prefix',
      '        hook hold',
      `          call ${tableOf(form)}/delete`,
      '            read held',
    )
  }

  return lines
}

function dispatchText(page: string, modules: Module[], all: Signature[], term: string, scope: Scope, name: string): string {
  temporaries = 0
  // a release crosses as `cask_release`, never as a command of its own
  const signatures = all.filter(signature => !isRelease(signature))
  const scoped = scopedCommands(signatures, modules)
  // what the gate reads, loaded only when something is scoped
  const gated = scoped.some(one => (one.checks ?? []).length > 0)
  const lines: string[] = [
    '',
    `# GENERATED by term make from ${relative(term, page)}. Do not edit; regenerate with`,
    `# \`term make --target <platform>\` or \`pnpm term:cask-generate --page ${relative(term, page)} --commit\`.`,
    '#',
    '# The cask side of the bridge for this app: the allowlist is exactly the commands the page docks plus the',
    "# cask's own, `run-command` calls the public task for each, and `dispatch` turns one message into one reply.",
    '# A message is `{ id, command, arguments }`. The reply is `{ id, value }`, or `{ id, exception }` when the',
    '# command is not allowed, and then nothing runs. An opaque handle a task answers is kept in a table here under a',
    '# fresh id, and the id is what the page gets; a handle the page sends back is looked up in the same table.',
    '#',
    "# EVERY HANDLE IS OWNED BY THE WINDOW THAT ASKED FOR IT (native-dom-0030). `serve` gives a window a key of its",
    "# own and answers its page under it: a handle is kept under `<key>/<id>`, so an id one window's page was given",
    "# is unknown to every other window's (refused as `absence`, as a forged one is), and when the window closes",
    '# every handle under its key is dropped. `dispatch` answers as one window, for an app that opens only one.',
    '#',
    "# AND EVERY COMMAND IS HELD TO THE APP'S SCOPE (app-scope): `out-of-scope` checks each argument a scoped capability's",
    '# task names against the patterns its scope.tree lists, and a refused one answers `out-of-scope` and runs nothing.',
    '',
    'load @term/cask/cask',
    '  find window',
    '  find on-message',
    '  find on-close',
    '  find exit',
    '  find quit',
    '  find bundle-path',
    '  find data-path',
    // the gate's own: `home-path` whenever there is a gate, used or not, so a scope that adds `$home` later changes only
    // the gate's body
    ...(gated ? ['  find home-path', '', 'load @term/cask/scope', '  find in-scope'] : []),
    '',
    'load @term/base/text',
    '  find starts-with',
    '',
    'load @term/base/console',
    '  find log',
    '',
  ]

  for (const module of modules) {
    const own = signatures.filter(s => s.module === module.name)

    if (own.length === 0) {
      continue
    }

    lines.push(`load ${module.importPath}`)

    if (module.pageEnv && !lines.includes('load @term/site/view/hosted')) {
      lines.splice(lines.length - 1, 0, 'load @term/site/view/hosted', '  find has-device-host', '')
    }

    for (const signature of own) {
      lines.push(`  find ${signature.task}, name ${module.name}-${signature.task}`)
    }

    for (const form of handleForms(own)) {
      lines.push(`  find ${form}`)
    }

    lines.push('')
  }

  lines.push(
    'load @term/base/json',
    '  find parse',
    '  find stringify',
    '  find field-text',
    '  find field-number',
    '  find field-boolean',
    '  find get-field',
    ...JSON_FINDS.filter(name => !['make-object', 'set-field'].includes(name) || true).map(name => `  find ${name}`),
    '',
    'load @term/base/float',
    '  find to-number',
    '  find to-decimal',
    '',
    'load @term/base/list',
    '  find list',
    '  find push',
    '',
    'load @term/base/hash',
    '  find hash',
    '  find get',
    '  find set',
    '',
    'load @term/base/uuid',
    '  find version4',
    '',
    'load @term/base/maybe',
    '  find maybe',
    '  find unwrap',

    '',
    ...bytesLoads(signatures),
    ...recordLoads(recordForms(signatures)),
  )

  for (const form of handleForms(signatures)) {
    // typed, so `make hash` is the native map even in a program that also holds the host dialect's `data`, whose
    // `case hash` is a constructor of the same name (native-dom-0019)
    lines.push(
      `# the ${form} values the page holds ids for`,
      `host ${tableOf(form)}`,
      '  make hash',
      '  like hash',
      '    like text',
      `    like ${form}`,
      '',
    )
  }


  itemsOf = 'items-of'
  lines.push(...itemsOfText(itemsOf))

  // a cask with no device host (built for bare rust) answers a device module with its `unavailable` fallback, which
  // is not the platform's answer: the page is told `unhosted` instead, and asks its WebView (device-layer-0013)
  if (signatures.some(signature => signature.result.kind === 'text' && modules.some(one => one.name === signature.module && one.pageEnv))) {
    lines.push(
      '# a device answer, or `unhosted` where this build has no device host and so only the fallback answered',
      'task device-answer',
      '  take given, like text',
      '  like text',
      '  fork test',
      '    hook test',
      '      call is-equal',
      '        read given',
      '        text <unavailable>',
      '    hook hold',
      '      fork test',
      '        hook test',
      '          call has-device-host',
      '        hook hold',
      '          save hosted, code 0',
      '        hook miss',
      '          send back',
      '            text <unhosted>',
      '  send back, read given',
      '',
    )
  }

  lines.push('# the commands this app allows: what its page docks, and nothing else', 'task is-allowed', '  take command, like text', '  like boolean', '  fork test')

  for (const command of [...signatures.map(commandOf), ...CASK_COMMANDS]) {
    lines.push('    hook test', '      call is-equal', '        read command', `        text <${command}>`, '    hook hold', '      send back, true')
  }

  lines.push(
    '    hook miss',
    '      send back, false',
    '',
    "# run one command with its arguments and answer the reply value as json, for the window whose key is `owner`",
    'task run-command',
    '  mark async',
    '  take owner, like text',
    '  take command, like text',
    '  take arguments, like dynamic',
    '  like dynamic',
    '  save line',
    '    call field-text',
    '      read arguments',
    '      text <text>',
    '  fork test',
  )

  for (const signature of signatures) {
    lines.push('    hook test', '      call is-equal', '        read command', `        text <${commandOf(signature)}>`, '    hook hold')

    const argumentLocals: string[] = []

    for (const param of signature.params) {
      const field = temporary('field')
      lines.push(`      save ${field}`, '        call get-field', '          read arguments', `          text <${param.name}>`)
      const value = caskFromJson(param.kind, field, '      ')
      lines.push(...value.lines)
      argumentLocals.push(value.local)
    }

    const call = [`call ${signature.module}-${signature.task}`, ...(signature.async ? ['  wait true'] : []), ...argumentLocals.map(local => `  read ${local}`)]

    // a device module's text answer goes through `device-answer`, which says `unhosted` for a build with no device host
    const device = signature.result.kind === 'text' && modules.some(one => one.name === signature.module && one.pageEnv)

    if (signature.result.kind === 'void') {
      lines.push(...call.map(line => `      ${line}`), '      send back', '        call make-null')
    } else if (device) {
      lines.push('      save given', ...call.map(line => `        ${line}`), '      save answer', '        call device-answer', '          read given')
      const json = caskToJson(signature.result, 'answer', '      ')
      lines.push(...json.lines, `      send back, read ${json.local}`)
    } else {
      lines.push('      save answer', ...call.map(line => `        ${line}`))
      const json = caskToJson(signature.result, 'answer', '      ')
      lines.push(...json.lines, `      send back, read ${json.local}`)
    }
  }

  lines.push(
    '    hook test',
    '      call is-equal',
    '        read command',
    '        text <cask_bundle_path>',
    '    hook hold',
    '      send back',
    '        call from-text',
    '          call bundle-path',
    '            wait true',
    '    hook test',
    '      call is-equal',
    '        read command',
    '        text <cask_data_path>',
    '    hook hold',
    '      send back',
    '        call from-text',
    '          call data-path',
    '            wait true',
    '            call field-text',
    '              read arguments',
    '              text <name>',
    '    hook test',
    '      call is-equal',
    '        read command',
    '        text <cask_exit>',
    '    hook hold',
    '      call exit',
    '        wait true',
    '        call to-number',
    '          call field-number',
    '            read arguments',
    '            text <status>',
    '      send back',
    '        call make-null',
    '    hook test',
    '      call is-equal',
    '        read command',
    '        text <cask_quit>',
    '    hook hold',
    '      call quit',
    '        wait true',
    '      send back',
    '        call make-null',
    ...releaseLines(handleForms(signatures)),
    '    hook miss',
    '      # cask_log: a line from the page, printed where the cask prints',
    '      call log',
    '        text <page: {{line}}>',
    '      send back',
    '        call make-null',
    '',
    ...scopeText(scoped, scope, name),
    '# one message in, one reply out. A command that raises answers the exception by name and note, so the page',
    '# gets a rejection and the cask keeps running. One outside the scope answers `out-of-scope` with the argument',
    'task answer',
    '  mark async',
    '  take owner, like text',
    '  take message, like text',
    '  like text',
    '  save request',
    '    call parse',
    '      read message',
    '  save id',
    '    call field-text',
    '      read request',
    '      text <id>',
    '  save command',
    '    call field-text',
    '      read request',
    '      text <command>',
    '  # `set-field` answers the object with the field set; on a backend where a json object is a value the one it',
    '  # was handed is unchanged, so the answer is what is kept',
    '  save reply',
    '    call set-field',
    '      call make-object',
    '      text <id>',
    '      call from-text',
    '        read id',
    '  fork test',
    '    hook test',
    '      call is-allowed',
    '        read command',
    '    hook hold',
    '      save refused',
    '        call out-of-scope',
    '          read command',
    '          call get-field',
    '            read request',
    '            text <arguments>',
    '      fork test',
    '        hook test',
    '          call is-unequal',
    '            read refused',
    '            text <>',
    '        hook hold',
    '          save reply',
    '            call set-field',
    '              read reply',
    '              text <exception>',
    '              call from-text',
    '                text <out-of-scope: {command} {refused}>',
    '        hook miss',
    '          mark unsafe',
    '            save reply',
    '              call set-field',
    '                read reply',
    '                text <value>',
    '                call run-command',
    '                  wait true',
    '                  read owner',
    '                  read command',
    '                  call get-field',
    '                    read request',
    '                    text <arguments>',
    '          halt take',
    '            take error',
    '            save reply',
    '              call set-field',
    '                read reply',
    '                text <exception>',
    '                call from-text',
    '                  text <{{error/form}}: {{error/note}}>',
    '    hook miss',
    '      save reply',
    '        call set-field',
    '          read reply',
    '          text <exception>',
    '          call from-text',
    '            text <command-not-allowed>',
    '  send back',
    '    call stringify',
    '      read reply',
    '',
    '# every message answered, whatever it holds: one that is not JSON (`parse` raises `json-mismatch`) answers the',
    '# exception with no id, rather than raising out of the bridge and taking the cask down with it. Answered for',
    "# the window whose key is `owner`",
    'task dispatch-as',
    '  mark async',
    '  take owner, like text',
    '  take message, like text',
    '  like text',
    '  mark unsafe',
    '    send back',
    '      call answer',
    '        wait true',
    '        read owner',
    '        read message',
    '  halt take',
    '    take problem',
    '    send back',
    '      call stringify',
    '        call set-field',
    '          call set-field',
    '            call make-object',
    '            text <id>',
    '            call from-text',
    '              text <>',
    '          text <exception>',
    '          call from-text',
    '            text <{{problem/form}}: {{problem/note}}>',
    '',
    '# one message, for an app with one window: `on-message(window, dispatch)`',
    'task dispatch',
    '  mark async',
    '  take message, like text',
    '  like text',
    '  send back',
    '    call dispatch-as',
    '      wait true',
    '      text <>',
    '      read message',
    '',
    "# every handle a window held, let go: what `serve` runs when the window closes",
    'task drop-window',
    '  take owner, like text',
    '  like void',
    ...dropLines(handleForms(signatures)),
    '',
    "# serve one window: its page's messages answered under a key of its own, so a handle that window's page holds is",
    "# unknown to every other window's, and every one of them is let go when the window closes. Answers the key",
    'task serve',
    '  take place, like window',
    '  like text',
    '  save key',
    '    call version4',
    '  call on-message',
    '    read place',
    '    task reply',
    '      mark async',
    '      take message, like text',
    '      like text',
    '      send back',
    '        call dispatch-as',
    '          wait true',
    '          read key',
    '          read message',
    '  call on-close',
    '    read place',
    '    task closed',
    '      call drop-window',
    '        read key',
    '  send back, read key',
    '',
  )

  return lines.join('\n')
}

// ---- the scope gate (app-scope, deck/call/code/scope.ts) ----

// a command the page may send whose capability is scoped, with the access each argument needs. `checks` is absent for
// a task the capability's table does not map, which the gate refuses: a task added to a module later is out of scope
// until somebody decides what it touches
type Scoped = { command: string; capability: string; checks?: [argument: string, access: Access][] }

function scopedCommands(signatures: Signature[], modules: Module[]): Scoped[] {
  const capabilityByModule = new Map(modules.map(module => [module.name, capabilityOf(module.publicFile)]))

  return signatures.flatMap(signature => {
    const capability = capabilityByModule.get(signature.module)
    const tasks = capability ? CAPABILITIES[capability]!.tasks : undefined

    return capability && tasks ? [{ command: commandOf(signature), capability, checks: tasks[signature.task] }] : []
  })
}

// the constant one capability's access is compiled into
const scopeHost = (capability: string, access: Access): string => `scope-${capability}-${access}`

// `out-of-scope`, and the patterns it reads: what the gate in `answer` asks before a command runs. It answers the
// argument it refused, or empty text. `name` is the app's, which its `$data` is the data directory of
function scopeText(scoped: Scoped[], scope: Scope, name: string): string[] {
  const head = [
    "# the app's scope (scope.tree, deck/call/code/scope.ts): every scoped argument of a command checked against the",
    '# patterns its access lists, before the command runs. Answers the argument refused, or empty text when it may run',
    'task out-of-scope',
  ]

  if (scoped.length === 0) {
    return [...head, '  take command, like text', '  take arguments, like dynamic', '  like text', '  send back, text <>', '']
  }

  const pairs = [...new Set(scoped.flatMap(one => (one.checks ?? []).map(([, access]) => `${one.capability}|${access}`)))]
  const lines: string[] = []

  for (const pair of pairs) {
    const [capability, access] = pair.split('|') as [string, Access]
    const patterns = scope.get(capability)?.[access] ?? []
    lines.push(`# what the scope lets the page ${access} through \`${capability}\``, `host ${scopeHost(capability, access)}`, `  text <${patterns.map(one => one.replace(/\\/g, '\\\\')).join('\\n')}>`, '')
  }

  lines.push(...head, '  mark async', '  take command, like text', '  take arguments, like dynamic', '  like text', '  fork test')

  for (const one of scoped) {
    lines.push('    hook test', '      call is-equal', '        read command', `        text <${one.command}>`, '    hook hold')

    if (!one.checks) {
      lines.push(`      send back, text <${one.command} is not in the scope table>`)
      continue
    }

    if (one.checks.length === 0) {
      lines.push('      send back, text <>')
      continue
    }

    // the directories a pattern's `$data`, `$bundle` and `$home` stand for, asked of the cask itself, and only those
    // a pattern of this command names: `data-path` makes the folder it answers, which a check must never do for a
    // scope that does not mention it. One no pattern names is empty, which matches nothing
    const named = (variable: string) =>
      one.checks!.some(([, access]) => (scope.get(one.capability)?.[access] ?? []).some(pattern => pattern.startsWith(variable)))
    lines.push(
      '      save data',
      ...(named('$data') ? ['        call data-path', `          text <${name}>`] : ['        text <>']),
      '      save bundle',
      ...(named('$bundle') ? ['        call bundle-path'] : ['        text <>']),
      '      save home',
      ...(named('$home') ? ['        call home-path'] : ['        text <>']),
    )

    for (const [index, [argument, access]] of one.checks.entries()) {
      const value = `scoped-${index}`
      lines.push(`      save ${value}`)
      lines.push(...(argument === '*' ? ['        text <*>'] : ['        call as-text', '          call get-field', '            read arguments', `            text <${argument}>`]))
      lines.push(
        '      fork test',
        '        hook test',
        '          call is-equal',
        '            call in-scope',
        `              read ${value}`,
        `              read ${scopeHost(one.capability, access)}`,
        `              text <${CAPABILITIES[one.capability]!.kind}>`,
        '              read data',
        '              read bundle',
        '              read home',
        '            false',
        '        hook hold',
        `          send back, read ${value}`,
      )
    }

    lines.push('      send back, text <>')
  }

  lines.push('  send back, text <>', '')

  return lines
}

// ---- the run ----

export type GenerateReport = {
  modules: string[]
  // generated shims for modules that no longer cross, rewritten to forward and waiting to be deleted by hand
  orphans: string[]
  carried: number
  refused: { module: string; task: string; reason: string }[]
  // the files that differ from disk, and whether each was written
  drift: { file: string; written: boolean }[]
  written: number
}

// generate for one page. `out` is where dispatch.tree goes, which is the cask entry's directory. `root` is the app's,
// whose scope.tree and manifest the gate is generated from; it is `out` when not given. Reports by default; `commit`
// writes what differs; the caller acts on `drift`
export function generateBridge({ page, out, commit, root: app = out }: { page: string; out: string; commit: boolean; root?: string }): GenerateReport {
  const base = stdlibBase()

  if (!base) {
    throw new Error('the stdlib was not found, so there is nothing to generate the bridge from. Set TERM_STDLIB')
  }

  const term = dirname(dirname(base))
  const root = dirname(page)
  const { modules, orphans } = dockedModules(page, root)
  const outputs: { file: string; text: string }[] = orphans.map(orphan => ({ file: orphan.shimFile, text: orphanText(orphan) }))
  const all: Signature[] = []
  const refusedAll: { module: string; task: string; reason: string }[] = []

  for (const module of modules) {
    const { carried, refused } = signaturesOf(module, term)

    if (carried.length === 0 && refused.length === 0) {
      continue
    }

    all.push(...carried)
    refusedAll.push(...refused.map(one => ({ module: module.name, task: one.task, reason: one.reason })))
    outputs.push({ file: module.shimFile, text: shimText(module, carried, refused, term) })
  }

  const { scope } = readScope(app)
  outputs.push({ file: join(out, 'dispatch.tree'), text: dispatchText(page, modules, all, term, scope, appIdentity(app).name) })

  const drift: { file: string; written: boolean }[] = []

  for (const output of outputs) {
    const before = existsSync(output.file) ? readFileSync(output.file, 'utf8') : undefined

    if (before === output.text) {
      continue
    }

    if (commit) {
      mkdirSync(dirname(output.file), { recursive: true })
      writeFileSync(output.file, output.text)
    }

    drift.push({ file: output.file, written: commit })
  }

  return {
    modules: modules.map(m => m.importPath),
    orphans: orphans.map(o => o.shimFile),
    carried: all.length,
    refused: refusedAll,
    drift,
    written: drift.filter(d => d.written).length,
  }
}
