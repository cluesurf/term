// An app's SCOPE (app-scope): what it may reach outside its own process, and over what. Deny by default, declared in
// ONE dialect, the app's `scope.tree`, a Term data file (note/term/host/), so there is nothing new to parse and `term
// lint` already reads it. Tauri says the same thing in four formats (note/term/app/04-do-better.md, "Capability in
// the grammar"); this keeps its scope model, which is right, and drops the other three encodings.
//
//   host file
//     list read, <$data/**>, <~/Documents/notes/**>
//     list write, <$data/**>
//   host environment
//     list read, <HOME>, <LANG>
//   host db
//
// Two checks read it, and this file is the one place both learn what a capability is:
//
//   at BUILD time, every app target   a program that reaches a capability its scope does not name is refused, naming
//                                     the capability and the module it was reached through. A `view` document cannot
//                                     reach one at all: its dialect has no word for a call (note/term/view/05-sandbox.md)
//   at RUN time, where a boundary is  the cask's dispatcher (deck/call/code/cask-generate.ts) checks each scoped
//                                     argument of each call from the WebView page against the scope before anything
//                                     runs, which is where Tauri checks. A native build is one compiled program with no
//                                     page to distrust, so there is no second check to make there
//
// A capability with no access lists (`host db`) is all or nothing: named, every task of it may run.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { expandData, readDataText, toJsonValue } from '@term/make/code/compile/host'

export type Access = 'read' | 'write'

// what each capability is, how a build finds it in a program (the module it is defined in, after symlinks), and, for
// a scoped one, the access each of its tasks needs over which argument. `*` as the argument is the capability's whole
// space (`variables` reads every name). A task of a scoped capability that is not listed is REFUSED at the boundary,
// so a task added to the module later is denied until it is mapped here
// `kind` is how a scoped capability's arguments are matched (deck/cask/code/scope.tree `in-scope`): as a `path`, with
// folders and wildcards, or as a `name`, whole
export const CAPABILITIES: Record<
  string,
  { what: string; module: RegExp; kind?: 'path' | 'name'; tasks?: Record<string, [argument: string, access: Access][]> }
> = {
  file: {
    what: 'files and folders, by path',
    module: /\/deck\/base\/code\/file(\.tree|\/)/,
    kind: 'path',
    tasks: {
      read: [['path', 'read']],
      'read-bytes': [['path', 'read']],
      test: [['path', 'read']],
      stat: [['path', 'read']],
      write: [['path', 'write']],
      'write-bytes': [['path', 'write']],
      append: [['path', 'write']],
      remove: [['path', 'write']],
      copy: [
        ['from', 'read'],
        ['to', 'write'],
      ],
      move: [
        ['from', 'write'],
        ['to', 'write'],
      ],
    },
  },
  environment: {
    what: 'environment variables, by name, and the working directory',
    module: /\/deck\/base\/code\/environment(\.tree|\/)/,
    kind: 'name',
    tasks: {
      variable: [['name', 'read']],
      'has-variable': [['name', 'read']],
      variables: [['*', 'read']],
      'set-variable': [['name', 'write']],
      'remove-variable': [['name', 'write']],
      directory: [],
      'change-directory': [['*', 'write']],
      locale: [],
      locales: [],
    },
  },
  process: { what: 'other programs', module: /\/deck\/base\/code\/process(\.tree|\/)/ },
  network: { what: 'the network', module: /\/deck\/base\/code\/network(\.tree|\/)/ },
  db: { what: 'a database', module: /\/deck\/site\/code\/base\/db\.tree$/ },
}

// a scope as declared: each capability named, with its access lists (empty for one that has none)
export type Scope = Map<string, Partial<Record<Access, string[]>>>

// the app's scope.tree read, or an empty scope (which denies every capability) when it has none. A file that is not
// data, names a capability that does not exist, or gives one an access it does not have is an error naming the line
export function readScope(root: string): { scope: Scope; file: string } {
  const file = join(root, 'scope.tree')
  const scope: Scope = new Map()

  if (!existsSync(file)) {
    return { scope, file }
  }

  const read = readDataText({ file, text: readFileSync(file, 'utf8') })

  if (!read.ok) {
    throw scopeError(`${file} is not a data file: ${read.diagnostics.map(d => d.message).join('; ')}`)
  }

  const expanded = expandData(read.data, file)

  if (!expanded.ok) {
    throw scopeError(`${file}: ${expanded.diagnostics.map(d => d.message).join('; ')}`)
  }

  const value = toJsonValue(expanded.data) as unknown

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw scopeError(`${file} holds a ${Array.isArray(value) ? 'list' : typeof value}; a scope is \`host\` entries, one per capability`)
  }

  for (const [name, lists] of Object.entries(value as Record<string, unknown>)) {
    const capability = CAPABILITIES[name.replace(/_/g, '-')]

    if (!capability) {
      throw scopeError(`${file} names \`${name}\`, which is not a capability. There are ${Object.keys(CAPABILITIES).map(one => `\`${one}\``).join(', ')}`)
    }

    const given: Partial<Record<Access, string[]>> = {}

    if (lists !== null && typeof lists === 'object' && !Array.isArray(lists)) {
      for (const [access, items] of Object.entries(lists as Record<string, unknown>)) {
        const allowed = new Set(Object.values(capability.tasks ?? {}).flatMap(pairs => pairs.map(([, one]) => one)))

        if (!allowed.has(access as Access)) {
          throw scopeError(`${file}: \`${name}\` has no \`${access}\` list. ${allowed.size > 0 ? `It has ${[...allowed].map(one => `\`${one}\``).join(' and ')}` : 'It is all or nothing: `host ' + name + '` alone'}`)
        }

        if (!Array.isArray(items) || items.some(item => typeof item !== 'string')) {
          throw scopeError(`${file}: \`${name}\` \`${access}\` is a list of text, each a pattern`)
        }

        // a pattern is compiled into the dispatcher as text, where these mean something else, and no path or name
        // needs them
        const odd = (items as string[]).find(item => /[<>{}\n]/.test(item) || item.length === 0)

        if (odd !== undefined) {
          throw scopeError(`${file}: \`${name}\` \`${access}\` holds ${odd.length === 0 ? 'an empty pattern' : `\`${odd}\``}, and a pattern is not empty and holds no \`<\`, \`>\`, \`{\`, \`}\` or line break`)
        }

        given[access as Access] = items as string[]
      }
    } else if (lists !== null && lists !== undefined) {
      throw scopeError(`${file}: \`${name}\` is \`host ${name}\` with its access lists beneath, not a value`)
    }

    scope.set(name, given)
  }

  return { scope, file }
}

// the capability a module file defines, or none
export function capabilityOf(file: string): string | undefined {
  const real = existsSync(file) ? realpathSync(file) : file

  return Object.entries(CAPABILITIES).find(([, capability]) => capability.module.test(real))?.[0]
}

// the capabilities a program reaches, each with the first module that defines it, from the files its build loaded
export function capabilitiesOf(files: string[]): Map<string, string> {
  const found = new Map<string, string>()

  for (const one of files) {
    const name = capabilityOf(one)

    if (name && !found.has(name)) {
      found.set(name, existsSync(one) ? realpathSync(one) : one)
    }
  }

  return found
}

// refuse a build that reaches a capability its scope does not name. One message per capability, each naming what it
// is, the module it came through, and the line that would grant it
export function checkScope(input: { root: string; files: string[] }): void {
  const { scope, file } = readScope(input.root)
  const missing = [...capabilitiesOf(input.files)].filter(([name]) => !scope.has(name))

  if (missing.length === 0) {
    return
  }

  const lines = missing.map(([name, module]) => `\`${name}\` (${CAPABILITIES[name]!.what}), reached through ${module}`)
  const grant = missing.map(([name]) => `host ${name}`).join(', ')

  throw scopeError(
    `This app reaches ${lines.join('; ')}, and ${existsSync(file) ? `its scope.tree does not name ${missing.length === 1 ? 'it' : 'them'}` : 'it has no scope.tree'}. An app may reach only what its scope names: add ${grant} to ${file}, with the access lists the capability takes`,
  )
}

function scopeError(message: string): Error {
  return Object.assign(new Error(message), { expected: true, failure: 'usage' })
}
