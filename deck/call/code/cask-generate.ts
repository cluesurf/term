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
// private `handle`: the value stays in the cask under a tone-code id and the page holds the id), and a LIST of any of
// those. A record with fields, bytes and a dynamic do not cross yet; such a task is emitted as a raise naming the
// reason, so the module still builds and the gap is visible rather than silent. Design: note/term/cask/readme.md.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { expandTemplates } from '@term/make/code/compile/template'
import { collectModules } from '@term/make/code/compile/load'
import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'
import { projectResolver } from '@term/call/code/make'
import { stdlibBase } from '@term/make/code/resolve'

// the commands every cask answers on its own behalf, in the order the dispatcher lists them
const CASK_COMMANDS = ['cask_bundle_path', 'cask_data_path', 'cask_exit', 'cask_quit', 'cask_log'] as const

// the modules the shim itself is written with, which therefore never cross
const NEVER_CROSS = new Set(['json', 'float', 'uuid'])

// the modules that cross even though the page could serve them: their browser impl is a sandbox stand-in (OPFS for
// `file`, an empty environment, a process that is a tab), and inside a cask the process is the truth
const CROSS_ANYWAY = new Set(['file', 'environment', 'process'])

// the env directories the page's own build can serve a module from: `webview` borrows `browser`, and the
// javascript-wide impls serve every javascript env
const PAGE_ENVS = ['webview', 'browser', 'javascript', 'shared']

// the env directories a cask's process can serve a module from
const CASK_ENVS = ['swift', 'kotlin', 'rust']

type Kind =
  | { kind: 'text' | 'boolean' | 'number' | 'decimal' | 'void' }
  // a value declared `like unknown` or `like dynamic`: it crosses AS its json, so a text, a number, a boolean or
  // null, which is what a database parameter is. A record here would arrive as a json object, not a Term record
  | { kind: 'dynamic' }
  | { kind: 'handle'; form: string }
  | { kind: 'list'; item: Kind }

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
  // the `load` path a program writes for the public module: `@term/site/code/base/db`
  importPath: string
  // the public module, the abstract module beside the env directories when it exists, and where the shim goes
  publicFile: string
  abstractFile?: string
  shimFile: string
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

// a form whose one field is a private `handle` is an opaque handle: the value stays in the cask, the page holds an id
function isHandleForm(form: RecordType): boolean {
  return form.fields.length === 1 && form.fields[0]!.name === 'handle' && form.variants.length === 0
}

function kindOf(type: Type | undefined, forms: Map<string, RecordType>): Kind | { refuse: string } {
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
      const item = kindOf(type.element, forms)

      if ('refuse' in item) {
        return { refuse: `a list of ${item.refuse}` }
      }

      if (item.kind === 'void') {
        return { refuse: 'a list of nothing' }
      }

      return { kind: 'list', item }
    }
    case 'named': {
      const form = forms.get(type.name)

      if (form && isHandleForm(form)) {
        return { kind: 'handle', form: type.name }
      }

      return { refuse: form ? `record ${type.name}` : `type ${type.name}` }
    }
    case 'unknown':
    case 'dynamic':
      return { kind: 'dynamic' }
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
  const forms = new Map<string, RecordType>()

  for (const statement of [...publicProgram, ...abstractProgram]) {
    if (statement.form === 'record-type') {
      forms.set(statement.name, statement)
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
  // `<package root>/code/<...>/native/node/<name>.tree`, wherever the package was resolved from
  const native = /^(.*\/deck\/([^/]+)\/code(?:\/(.*))?)\/native\/node\/([^/]+)\.tree$/

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
    const caskServes = CASK_ENVS.some(has)

    if (!caskServes || (pageServes && !CROSS_ANYWAY.has(name!))) {
      const served = PAGE_ENVS.find(env => env !== 'webview' && has(env))

      if (generated && served) {
        orphans.push({ shimFile, forward: `../${served}/${name}` })
      }

      continue
    }

    const abstractFile = join(codeDir!, 'native', `${name}.tree`)
    const importPath = `@term/${packageName}/code/${under ? `${under}/` : ''}${name}`

    found.set(importPath, {
      name: name!,
      importPath,
      publicFile,
      abstractFile: existsSync(abstractFile) ? abstractFile : undefined,
      shimFile,
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
    case 'list':
      return ['like list', ...likeOf(kind.item).map(line => `  ${line}`)]
  }
}

const INVOKE: Record<Exclude<Kind, { kind: 'list' | 'handle' | 'dynamic' }>['kind'], string> = {
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
    case 'handle':
      // the page holds the id in the form's private field
      return { local, lines: [`${indent}save ${local}`, `${indent}  call from-text`, `${indent}    read ${read}/handle`] }
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
    case 'handle':
      return {
        local,
        lines: [`${indent}save ${local}`, `${indent}  make ${kind.form}`, `${indent}    bind handle`, `${indent}      call as-text`, `${indent}        read ${read}`],
      }
    case 'list':
      return listFromJson(kind.item, read, indent, pageFromJson)
  }
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

      return {
        local,
        lines: [
          `${indent}save ${found}`,
          `${indent}  call get`,
          `${indent}    read ${tableOf(kind.form)}`,
          `${indent}    call as-text`,
          `${indent}      read ${read}`,
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
          `${indent}save ${id}`,
          `${indent}  call version4`,
          `${indent}call set`,
          `${indent}  read ${tableOf(kind.form)}`,
          `${indent}  read ${id}`,
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
    'load @term/seed/code/json',
    ...JSON_FINDS.map(name => `  find ${name}`),
    '',
    'load @term/seed/code/float',
    '  find to-decimal',
    '  find to-number',
    '',
    'load @term/seed/code/list',
    '  find list',
    '  find push',
    '',
  ]

  for (const form of handleForms(carried)) {
    lines.push(`# an opaque handle: the id of a value the cask holds`, `form ${form}`, '  link handle, mark private', '')
  }

  itemsOf = `${module.name}-items-of`
  lines.push(...itemsOfText(itemsOf))

  for (const signature of carried) {
    lines.push(`task ${signature.native}`, '  note async')

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

    if (result.kind === 'list' || result.kind === 'handle' || result.kind === 'dynamic') {
      lines.push('  save reply', '    call bridge/invoke', '      wait true', `      text <${commandOf(signature)}>`, '      read arguments')
      const value = pageFromJson(result, 'reply', '  ')
      lines.push(...value.lines, `  send back, read ${value.local}`)
    } else if (result.kind === 'void') {
      lines.push(`  call bridge/${INVOKE[result.kind]}`, '    wait true', `    text <${commandOf(signature)}>`, '    read arguments')
    } else {
      lines.push('  send back', `    call bridge/${INVOKE[result.kind]}`, '      wait true', `      text <${commandOf(signature)}>`, '      read arguments')
    }

    lines.push('')
  }

  for (const one of refused) {
    lines.push(`# not carried: ${one.reason}`, `task ${one.native}`, '  note async')

    for (const param of one.params) {
      lines.push(`  take ${param.name}, like unknown`)
    }

    lines.push('  like unknown', `  halt <${one.module}/${one.task} does not cross the cask bridge yet: ${one.reason}>`, '')
  }

  return lines.join('\n')
}

function dispatchText(page: string, modules: Module[], signatures: Signature[], term: string): string {
  temporaries = 0
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
    '',
    'load @term/cask/code/cask',
    '  find exit',
    '  find quit',
    '  find bundle-path',
    '  find data-path',
    '',
    'load @term/seed/code/console',
    '  find log',
    '',
  ]

  for (const module of modules) {
    const own = signatures.filter(s => s.module === module.name)

    if (own.length === 0) {
      continue
    }

    lines.push(`load ${module.importPath}`)

    for (const signature of own) {
      lines.push(`  find ${signature.task}, name ${module.name}-${signature.task}`)
    }

    for (const form of handleForms(own)) {
      lines.push(`  find ${form}`)
    }

    lines.push('')
  }

  lines.push(
    'load @term/seed/code/json',
    '  find parse',
    '  find stringify',
    '  find field-text',
    '  find field-number',
    '  find field-boolean',
    '  find get-field',
    ...JSON_FINDS.filter(name => !['make-object', 'set-field'].includes(name) || true).map(name => `  find ${name}`),
    '',
    'load @term/seed/code/float',
    '  find to-number',
    '  find to-decimal',
    '',
    'load @term/seed/code/list',
    '  find list',
    '  find push',
    '',
    'load @term/seed/code/hash',
    '  find hash',
    '  find get',
    '  find set',
    '',
    'load @term/seed/code/uuid',
    '  find version4',
    '',
    'load @term/seed/code/maybe',
    '  find maybe',
    '  find unwrap',
    '',
  )

  for (const form of handleForms(signatures)) {
    lines.push(`# the ${form} values the page holds ids for`, `host ${tableOf(form)}`, '  make hash', '')
  }

  itemsOf = 'items-of'
  lines.push(...itemsOfText(itemsOf))

  lines.push('# the commands this app allows: what its page docks, and nothing else', 'task is-allowed', '  take command, like text', '  like boolean', '  fork test')

  for (const command of [...signatures.map(commandOf), ...CASK_COMMANDS]) {
    lines.push('    hook test', '      call is-equal', '        read command', `        text <${command}>`, '    hook hold', '      send back, true')
  }

  lines.push(
    '    hook miss',
    '      send back, false',
    '',
    '# run one command with its arguments and answer the reply value as json',
    'task run-command',
    '  note async',
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

    if (signature.result.kind === 'void') {
      lines.push(...call.map(line => `      ${line}`), '      send back', '        call make-null')
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
    '    hook miss',
    '      # cask_log: a line from the page, printed where the cask prints',
    '      call log',
    '        text <page: {{line}}>',
    '      send back',
    '        call make-null',
    '',
    '# one message in, one reply out. A command that raises answers the exception by name and note, so the page',
    '# gets a rejection and the cask keeps running',
    'task dispatch',
    '  note async',
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
    '      note unsafe',
    '        save reply',
    '          call set-field',
    '            read reply',
    '            text <value>',
    '            call run-command',
    '              wait true',
    '              read command',
    '              call get-field',
    '                read request',
    '                text <arguments>',
    '      halt take',
    '        take error',
    '        save reply',
    '          call set-field',
    '            read reply',
    '            text <exception>',
    '            call from-text',
    '              text <{{error/form}}: {{error/note}}>',
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
  )

  return lines.join('\n')
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

// generate for one page. `out` is where dispatch.tree goes, which is the cask entry's directory. Reports by default;
// `commit` writes what differs; the caller acts on `drift`
export function generateBridge({ page, out, commit }: { page: string; out: string; commit: boolean }): GenerateReport {
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

  outputs.push({ file: join(out, 'dispatch.tree'), text: dispatchText(page, modules, all, term) })

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
