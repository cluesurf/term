// The cask bridge generator: from the public signatures of every stdlib module a page docks, mint the `webview` env
// shim for that module and the app's dispatcher with its allowlist. Nobody writes the seam twice and nobody keeps
// two copies in step. `term make --target <platform>` runs it before every build; `pnpm term:cask-generate` runs it
// alone, and with --check holds what is on disk to it. Item cask-0005; the shape is the one cask-0004 wrote by hand.
//
// The page's module closure, resolved for the `node` env, names every stdlib module with a native half (a source
// under deck/seed/code/native/node/). For each, the PUBLIC module (deck/seed/code/<name>.tree) gives the task
// signatures and which native task each public task forwards to.
//
// Two outputs per run:
//   deck/seed/code/native/webview/<name>.tree     the shim: each native task the public module finds, as one
//                                                  command over the bridge named <name>_<public task>
//   <out>/dispatch.tree                            the cask side: `is-allowed` over exactly those commands plus the
//                                                  cask's own, `run-command` calling the public task, `dispatch`
//
// What crosses today: text, boolean, number, decimal, and nothing (void). A task with any other parameter or result
// (bytes, records, lists, dynamic) is emitted as a raise naming the reason, so the module still builds and the gap is
// visible rather than silent. Bytes and records are the next thing this generator learns. Design: note/term/cask/.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { expandTemplates } from '@term/make/code/compile/template'
import { collectModules } from '@term/make/code/compile/load'
import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'
import { projectResolver } from '@term/call/code/make'
import { stdlibBase } from '@term/make/code/resolve'

// the commands every cask answers on its own behalf, in the order the dispatcher lists them
const CASK_COMMANDS = ['cask_bundle_path', 'cask_data_path', 'cask_exit', 'cask_quit', 'cask_log'] as const

type Kind = 'text' | 'boolean' | 'number' | 'decimal' | 'void'

type Param = { name: string; kind: Kind }

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

function kindOf(type: Type | undefined): Kind | undefined {
  if (!type) {
    return 'void'
  }

  switch (type.kind) {
    case 'string':
      return 'text'
    case 'boolean':
      return 'boolean'
    case 'number':
      return 'number'
    case 'float':
      return 'decimal'
    case 'unit':
      return 'void'
    default:
      return undefined
  }
}

function describe(type: Type | undefined): string {
  if (!type) {
    return 'void'
  }

  return type.kind === 'named' ? type.name : type.kind
}

// the first call in a body, which in a stdlib public module is the forward to the native task
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

// every public task of a stdlib module, split into what the bridge carries and what it refuses
function signaturesOf(seed: string, module: string): { carried: Signature[]; refused: Refused[] } {
  const file = join(seed, `${module}.tree`)

  if (!existsSync(file)) {
    return { carried: [], refused: [] }
  }

  const carried: Signature[] = []
  const refused: Refused[] = []

  for (const statement of programOf(file, dirname(seed))) {
    if (statement.form !== 'function' || statement.private) {
      continue
    }

    const native = forwardedTo(statement.body)

    if (!native) {
      continue
    }

    const params: Param[] = []
    let reason: string | undefined

    for (const param of statement.params) {
      const kind = kindOf(param.type)

      if (!kind || kind === 'void') {
        reason = `parameter ${param.name} is ${describe(param.type)}`
        break
      }

      params.push({ name: param.name, kind })
    }

    const result = kindOf(statement.result)

    if (!reason && !result) {
      reason = `result is ${describe(statement.result)}`
    }

    if (reason || !result) {
      refused.push({
        module,
        task: statement.name,
        native,
        params: statement.params.map(p => ({ name: p.name })),
        reason: reason ?? 'unknown',
      })
      continue
    }

    carried.push({
      module,
      task: statement.name,
      native,
      params,
      result,
      async: Boolean(statement.async),
    })
  }

  return { carried, refused }
}

// the stdlib modules the page reaches that have a native half: the closure resolved for node names them
function dockedModules(page: string, root: string, seed: string): string[] {
  const sources = collectModules(
    { file: page, text: readFileSync(page, 'utf8') },
    projectResolver(root, 'node'),
  ).sources

  const modules = new Set<string>()
  // the node native of a stdlib module, wherever the stdlib was resolved from: an app resolves it through its own
  // link directory, a task through the sibling package, and the real path is the same file either way
  const native = /\/native\/node\/([^/]+)\.tree$/

  for (const source of sources) {
    const real = existsSync(source.file) ? realpathSync(source.file) : source.file

    if (!real.startsWith(realpathSync(seed))) {
      continue
    }

    const found = native.exec(real)

    if (found) {
      const rest = found[1]

      // one level only for now: `file`, not `file/asynchronous`. The nested families come with bytes and records.
      // json and float are what the shim itself is written with, so they never cross
      if (rest !== 'json' && rest !== 'float') {
        modules.add(rest)
      }
    }
  }

  return [...modules].sort()
}

// ---- writing tree ----

const commandOf = (signature: Signature): string =>
  `${signature.module}_${signature.task}`.replaceAll('-', '_')

const INVOKE: Record<Kind, string> = {
  text: 'invoke-text',
  boolean: 'invoke-boolean',
  number: 'invoke-number',
  decimal: 'invoke-decimal',
  void: 'invoke-void',
}

const LIKE: Record<Kind, string> = {
  text: 'text',
  boolean: 'boolean',
  number: 'number',
  decimal: 'decimal',
  void: 'void',
}

// a json value from a Term value of this kind
function toJson(kind: Kind, read: string, indent: string): string[] {
  switch (kind) {
    case 'text':
      return [`${indent}call from-text`, `${indent}  read ${read}`]
    case 'boolean':
      return [`${indent}call from-boolean`, `${indent}  read ${read}`]
    case 'number':
      return [`${indent}call from-number`, `${indent}  call to-decimal`, `${indent}    read ${read}`]
    case 'decimal':
      return [`${indent}call from-number`, `${indent}  read ${read}`]
    case 'void':
      return [`${indent}call make-null`]
  }
}

// a Term value of this kind from a json field
function fromJson(kind: Kind, object: string, key: string, indent: string): string[] {
  switch (kind) {
    case 'text':
      return [`${indent}call field-text`, `${indent}  read ${object}`, `${indent}  text <${key}>`]
    case 'boolean':
      return [`${indent}call field-boolean`, `${indent}  read ${object}`, `${indent}  text <${key}>`]
    case 'number':
      return [
        `${indent}call to-number`,
        `${indent}  call field-number`,
        `${indent}    read ${object}`,
        `${indent}    text <${key}>`,
      ]
    case 'decimal':
      return [`${indent}call field-number`, `${indent}  read ${object}`, `${indent}  text <${key}>`]
    case 'void':
      return [`${indent}call make-null`]
  }
}

// the arguments object: `set-field` nested once per parameter, innermost first, because on a backend where a json
// object is a value the answer of each `set-field` is the object to keep
function argumentsObject(params: Param[], indent: string): string[] {
  let lines = [`${indent}call make-object`]

  for (const param of params) {
    const inner = lines.map(line => `  ${line}`)
    lines = [`${indent}call set-field`, ...inner, `${indent}  text <${param.name}>`, ...toJson(param.kind, param.name, `${indent}  `)]
  }

  return lines
}

function shimText(module: string, carried: Signature[], refused: Refused[]): string {
  const lines: string[] = [
    '',
    `# GENERATED by term make from deck/seed/code/${module}.tree. Do not edit; regenerate with`,
    `# \`term make --target <platform>\` or \`pnpm term:cask-generate --page <page> --commit\`.`,
    '#',
    `# The \`${module}\` module from inside a cask's page. Every task is one command over the bridge to the cask, which`,
    `# runs the same public task in the env that is native there. The command name is the public module, an`,
    `# underscore, the public task, with hyphens as underscores. Internal: reached only through the public ${module} API.`,
    '',
    'dock load',
    '  load <global:bridge>, name bridge',
    '',
    'load @term/seed/code/json',
    '  find make-object',
    '  find set-field',
    '  find from-text',
    '  find from-boolean',
    '  find from-number',
    '  find make-null',
    '',
    'load @term/seed/code/float',
    '  find to-decimal',
    '',
  ]

  for (const signature of carried) {
    lines.push(`task ${signature.native}`, '  note async')

    for (const param of signature.params) {
      lines.push(`  take ${param.name}, like ${LIKE[param.kind]}`)
    }

    lines.push(`  like ${LIKE[signature.result]}`)

    const call = [
      `call bridge/${INVOKE[signature.result]}`,
      `  wait true`,
      `  text <${commandOf(signature)}>`,
      ...argumentsObject(signature.params, '  '),
    ]

    if (signature.result === 'void') {
      lines.push(...call.map(line => `  ${line}`))
    } else {
      lines.push('  send back', ...call.map(line => `    ${line}`))
    }

    lines.push('')
  }

  for (const one of refused) {
    lines.push(`# not carried: ${one.reason}`, `task ${one.native}`, '  note async')

    for (const param of one.params) {
      lines.push(`  take ${param.name}, like unknown`)
    }

    lines.push(`  like unknown`, `  halt <${one.module}/${one.task} does not cross the cask bridge yet: ${one.reason}>`, '')
  }

  return lines.join('\n')
}

function dispatchText(page: string, out: string, term: string, signatures: Signature[]): string {
  const modules = [...new Set(signatures.map(s => s.module))].sort()
  const lines: string[] = [
    '',
    `# GENERATED by term make from ${relative(term, page)}. Do not edit; regenerate with`,
    `# \`term make --target <platform>\` or \`pnpm term:cask-generate --page ${relative(term, page)} --commit\`.`,
    '#',
    '# The cask side of the bridge for this app: the allowlist is exactly the commands the page docks plus the',
    "# cask's own, `run-command` calls the public task for each, and `dispatch` turns one message into one reply.",
    '# A message is `{ id, command, arguments }`. The reply is `{ id, value }`, or `{ id, exception }` when the',
    '# command is not allowed, and then nothing runs.',
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
    lines.push(`load @term/seed/code/${module}`)

    for (const signature of signatures.filter(s => s.module === module)) {
      lines.push(`  find ${signature.task}, name ${module}-${signature.task}`)
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
    '  find make-object',
    '  find set-field',
    '  find from-text',
    '  find from-boolean',
    '  find from-number',
    '  find make-null',
    '',
    'load @term/seed/code/float',
    '  find to-number',
    '  find to-decimal',
    '',
    '# the commands this app allows: what its page docks, and nothing else',
    'task is-allowed',
    '  take command, like text',
    '  like boolean',
    '  fork test',
  )

  const commands = [...signatures.map(commandOf), ...CASK_COMMANDS]

  for (const command of commands) {
    lines.push('    hook test', '      call is-equal', '        read command', `        text <${command}>`, '    hook hold', '      send back, true')
  }

  lines.push('    hook miss', '      send back, false', '', '# run one command with its arguments and answer the reply value as json', 'task run-command', '  note async', '  take command, like text', '  take arguments, like dynamic', '  like dynamic', '  save line', '    call field-text', '      read arguments', '      text <text>', '  fork test')

  for (const signature of signatures) {
    lines.push('    hook test', '      call is-equal', '        read command', `        text <${commandOf(signature)}>`, '    hook hold')

    const call = [`call ${signature.module}-${signature.task}`, ...(signature.async ? ['  wait true'] : [])]

    for (const param of signature.params) {
      call.push(...fromJson(param.kind, 'arguments', param.name, '  '))
    }

    if (signature.result === 'void') {
      lines.push(...call.map(line => `      ${line}`), '      send back', '        call make-null')
    } else {
      lines.push('      save answer', ...call.map(line => `        ${line}`), '      send back', ...toJson(signature.result, 'answer', '        '))
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
    '# one message in, one reply out',
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
    '      save reply',
    '        call set-field',
    '          read reply',
    '          text <value>',
    '          call run-command',
    '            wait true',
    '            read command',
    '            call get-field',
    '              read request',
    '              text <arguments>',
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


export type GenerateReport = {
  modules: string[]
  carried: number
  refused: { module: string; task: string; reason: string }[]
  // the files that differ from disk, and whether each was written
  drift: { file: string; written: boolean }[]
  written: number
}

// generate for one page. `out` is where dispatch.tree goes, which is the cask entry's directory. Reports by default;
// `commit` writes what differs; `check` is the caller's to act on through `drift`
export function generateBridge({
  page,
  out,
  commit,
}: {
  page: string
  out: string
  commit: boolean
}): GenerateReport {
  const base = stdlibBase()

  if (!base) {
    throw new Error('the stdlib was not found, so there is nothing to generate the bridge from. Set TERM_STDLIB')
  }

  // `stdlibBase` is the package (deck/seed); its modules are under code/
  const seed = join(base, 'code')
  const term = dirname(dirname(base))
  const root = dirname(page)
  const webview = join(seed, 'native/webview')
  const modules = dockedModules(page, root, seed)
  const outputs: { file: string; text: string }[] = []
  const all: Signature[] = []
  const refusedAll: { module: string; task: string; reason: string }[] = []

  for (const module of modules) {
    const { carried, refused } = signaturesOf(seed, module)

    if (carried.length === 0 && refused.length === 0) {
      continue
    }

    all.push(...carried)
    refusedAll.push(...refused.map(one => ({ module, task: one.task, reason: one.reason })))
    outputs.push({ file: join(webview, `${module}.tree`), text: shimText(module, carried, refused) })
  }

  outputs.push({ file: join(out, 'dispatch.tree'), text: dispatchText(page, out, term, all) })

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
    modules,
    carried: all.length,
    refused: refusedAll,
    drift,
    written: drift.filter(d => d.written).length,
  }
}
