// `term knit`, THE LAW LIBRARY (note/project/term/assurance/prove-loop/decision/002-law-library.md). A law the person
// names with `--law <name>` is a fixed Term statement, a template in @term/site/law/<name>.tree (`tree <name>-law`),
// generic over the app's forms and its step or view task. The model fills the template's holes with the app's own names
// (`fuse <name>-law` / `bind view, view`) and proves the claim it makes with a `task <name>`. It never writes the claim.
//
// Two things here, each a plain function of the project's files:
//   - THE SEAL. Before every round the loop appends the library's template text below a marker in each file that fuses
//     it, so the claim is made IN that file: the build, `term hold --report` and the Lean exporter all expand a file's
//     own templates, and none of the last two reads a template another file defines.
//   - THE INSTANCE CHECK. The claim named <name> in the project must be the one the library's template makes with the
//     project's fill: the project's claim and the template expanded alone with the same fill are milled the way the
//     build mills them and compared node for node (positions set aside). A claim written by hand, a second template of
//     the same name, a missing or partial fill, and a fill naming something that is not the app's own (a form or task
//     defined in a file other than the one stating the law) are each refused with a message the model reads.
//
// The kernel then checks the model's `task <name>` against that claim, which is the library's statement filled in, so
// what is proven is the library's law of the app's own forms and tasks. Lean re-checks it under `--lean`.

import path from 'node:path'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parse } from '@term/make/code/parser/tree'
import { groupsOf } from '@term/make/code/parser/narrow'
import type { RootNode } from '@term/make/code/parser/narrow'
import type { Node } from '@term/make/code/parser/tree'
import { headWord } from '@term/make/code/compile/mill-run'
import { collectTemplates, expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { lawSentences } from '@term/make/code/check/law-english'
import type { LawInstance } from '@term/call/code/knit-plan'

// the line the library's text is appended under. Everything from it to the end of a file is the loop's, written again
// before every round, so a model that edits it changes nothing
export const LIBRARY_MARK = '# ---- THE LAW LIBRARY (@term/site/law), appended by term knit before every round. Never edit below this line ----'

export type LibraryLaw = {
  // the law, and the claim the template makes
  name: string
  // the template, `<name>-law`
  template: string
  // the library file, absolute
  file: string
  text: string
  // the template's holes, in order
  params: string[]
}

export function libraryDir(root: string): string {
  return path.join(root, 'deck/site/code/law')
}

// every law of the library, by name
export function libraryNames(root: string): string[] {
  const dir = libraryDir(root)

  return existsSync(dir)
    ? readdirSync(dir)
        .filter(name => name.endsWith('.tree'))
        .map(name => name.slice(0, -'.tree'.length))
        .sort()
    : []
}

// one law of the library: its file must parse and define the template `<name>-law`
export function libraryLaw(root: string, name: string): LibraryLaw | undefined {
  const file = path.join(libraryDir(root), `${name}.tree`)

  if (!libraryNames(root).includes(name)) {
    return undefined
  }

  const text = readFileSync(file, 'utf8')
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return undefined
  }

  const template = `${name}-law`
  const found = collectTemplates(parsed.tree).get(template)

  return found ? { name, template, file, text, params: found.params } : undefined
}

// ---- reading a file's own text ----

// a file's text above the marker: what the model wrote
export function ownText(text: string): string {
  if (text.startsWith(LIBRARY_MARK)) {
    return ''
  }

  const at = text.indexOf(`\n${LIBRARY_MARK}`)

  return at < 0 ? text : text.slice(0, at + 1)
}

// the 1-based line the marker is on, if the file has one
export function markLine(text: string): number | undefined {
  const lines = text.split('\n')
  const at = lines.indexOf(LIBRARY_MARK)

  return at < 0 ? undefined : at + 1
}

// one word: a group holding one name and nothing else
function wordOf(node: Node | undefined): string | undefined {
  if (node?.kind !== 'group' || node.nodes.length !== 1 || node.nodes[0]?.kind !== 'name') {
    return undefined
  }

  return headWord(node)
}

export type Fuse = { template: string; fill: Record<string, string>; problems: string[] }

// every top-level `fuse` of a parse tree, and its fill as `bind <hole>, <name>` lines
export function fusesOf(tree: RootNode): Fuse[] {
  const out: Fuse[] = []

  for (const group of groupsOf(tree.nodes)) {
    if (headWord(group) !== 'fuse') {
      continue
    }

    const template = wordOf(group.nodes[1])

    if (!template) {
      continue
    }

    const fill: Record<string, string> = {}
    const problems: string[] = []

    for (const child of group.nodes.slice(2)) {
      if (child.kind !== 'group' || headWord(child) !== 'bind') {
        problems.push('every line under the fuse is `bind <hole>, <name>`')
        continue
      }

      const hole = wordOf(child.nodes[1])
      const value = wordOf(child.nodes[2])

      if (!hole || !value || child.nodes.length !== 3) {
        problems.push('a `bind` under the fuse names one hole and one form or task: `bind view, view`')
        continue
      }

      fill[hole] = value
    }

    out.push({ template, fill, problems })
  }

  return out
}

// the top-level rules a parse tree writes by hand, by name
function rulesOf(tree: RootNode): string[] {
  return groupsOf(tree.nodes).flatMap(group => {
    const named = group.nodes[1]
    const name = headWord(group) === 'rule' && named?.kind === 'group' ? headWord(named) : undefined
    return name ? [name] : []
  })
}

// ---- the seal ----

function treeFiles(project: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const file = path.join(dir, name.name)

      if (name.isDirectory()) {
        walk(file)
      } else if (name.name.endsWith('.tree')) {
        out.push(file)
      }
    }
  }
  walk(path.join(project, 'code'))

  return out.sort()
}

// the text a file should hold: what the model wrote, and under the marker each library law it fuses
export function sealed(text: string, laws: LibraryLaw[]): string {
  const own = ownText(text)
  const parsed = parse({ file: 'x.tree', text: own })
  const fused = parsed.ok ? new Set(fusesOf(parsed.tree).map(fuse => fuse.template)) : new Set<string>()
  // by name, so a file seals to the same text whatever order the laws were given in
  const needed = laws.filter(law => fused.has(law.template)).sort((a, b) => a.name.localeCompare(b.name))

  if (needed.length === 0) {
    return own
  }

  return `${own.trimEnd()}\n\n${LIBRARY_MARK}\n\n${needed.map(law => law.text.trimEnd()).join('\n\n')}\n`
}

// seal every file of the project, and say which changed
export function seal(project: string, laws: LibraryLaw[]): string[] {
  const changed: string[] = []

  for (const file of treeFiles(project)) {
    const text = readFileSync(file, 'utf8')
    const next = sealed(text, laws)

    if (next !== text) {
      writeFileSync(file, next)
      changed.push(path.relative(project, file))
    }
  }

  return changed
}

// ---- the instance check ----

export type Instance = LawInstance

type Statement = Record<string, unknown> & { form?: string; name?: unknown; claim?: boolean; theorem?: boolean; axiom?: boolean }

const isRule = (s: Statement): boolean => s.form === 'function' && (s.claim === true || s.theorem === true || s.axiom === true)

// a milled statement as data, its positions set aside, so two spellings at different places compare equal
function shapeOf(statement: unknown): string {
  return JSON.stringify(statement, (key, value) => (key === 'span' || key === 'file' ? undefined : value))
}

function milled(file: string, text: string, role: string | undefined, lean: boolean): { ok: true; program: Statement[] } | { ok: false; error: string } {
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return { ok: false, error: `it does not parse: ${parsed.diagnostics[0]?.message ?? 'failed'}` }
  }

  const built = mill(expandTemplates(parsed.tree), file, role, lean)

  if (!built.ok) {
    return { ok: false, error: `it does not mill: ${built.diagnostics[0]?.message ?? 'failed'}` }
  }

  return { ok: true, program: built.program as unknown as Statement[] }
}

function sentenceOf(statement: Statement | undefined): string | undefined {
  if (!statement) {
    return undefined
  }

  const said = lawSentences([statement])[0]

  return said?.text
}

export function fuseText(law: LibraryLaw, fill: Record<string, string>): string {
  return [`fuse ${law.template}`, ...law.params.map(param => `  bind ${param}, ${fill[param] ?? param}`)].join('\n')
}

// how a law is stated: the fuse to write, each hole a name of the app's
export function howToState(law: LibraryLaw): string {
  return [`fuse ${law.template}`, ...law.params.map(param => `  bind ${param}, <your ${param}>`)].join('\n')
}

// THE INSTANCE CHECK, over the project's files as they are on disk (sealed or not: the marker and what is under it are
// the loop's, and the check reads both the model's text and the library's)
export function checkInstances(input: {
  project: string
  required: string[]
  laws: LibraryLaw[]
  roleOf: (file: string) => string | null | undefined
  leanOf: (file: string) => boolean
}): Instance[] {
  const files = treeFiles(input.project).map(file => {
    const text = readFileSync(file, 'utf8')
    const own = ownText(text)
    const parsed = parse({ file, text: own })
    return { file, rel: path.relative(input.project, file), text, own, tree: parsed.ok ? parsed.tree : undefined }
  })

  // what each file defines, by name: the app's forms and tasks, read from the model's own text
  const defined = new Map<string, Set<string>>()

  for (const one of files) {
    const read = milled(one.file, one.own, input.roleOf(one.file) ?? undefined, input.leanOf(one.file))
    defined.set(one.file, new Set(read.ok ? read.program.filter(s => !isRule(s) && typeof s.name === 'string').map(s => s.name as string) : []))
  }

  return input.required.map((name): Instance => {
    const law = input.laws.find(one => one.name === name)

    if (!law) {
      return { law: name, ok: false, problem: `there is no law named ${name} in the law library` }
    }

    const refuse = (problem: string, more: Partial<Instance> = {}): Instance => ({ law: name, ok: false, problem, ...more })
    const statesBy = `State it with\n\n${howToState(law)}\n\nin code/law.tree, each hole bound to the name of your app's own form or task, and prove the claim it makes with \`task ${name}\`.`

    // a claim of the same name written by hand
    const byHand = files.filter(one => one.tree && rulesOf(one.tree).includes(name))

    if (byHand.length > 0) {
      return refuse(`\`rule ${name}\` is written by hand in ${byHand.map(one => one.rel).join(', ')}. ${name} is a law of the library and may not be restated: remove that rule. ${statesBy}`)
    }

    // a template of the library's name written by hand
    const ownTemplate = files.filter(one => one.tree && collectTemplates(one.tree).has(law.template))

    if (ownTemplate.length > 0) {
      return refuse(`\`tree ${law.template}\` is written by hand in ${ownTemplate.map(one => one.rel).join(', ')}. The template is the library's, and the loop appends it: remove yours.`)
    }

    const fusing = files.flatMap(one => (one.tree ? fusesOf(one.tree).filter(fuse => fuse.template === law.template).map(fuse => ({ one, fuse })) : []))

    if (fusing.length === 0) {
      return refuse(`${name} is not stated. ${statesBy}`)
    }

    if (fusing.length > 1) {
      return refuse(`${name} is fused ${fusing.length} times (${fusing.map(f => f.one.rel).join(', ')}): fuse it once.`)
    }

    const { one, fuse } = fusing[0]!
    const fill = fuse.fill
    const at = { file: one.rel, fill }

    if (fuse.problems.length > 0) {
      return refuse(`the fuse of ${law.template} in ${one.rel}: ${fuse.problems[0]}. ${statesBy}`, at)
    }

    const missing = law.params.filter(param => !(param in fill))
    const unknown = Object.keys(fill).filter(hole => !law.params.includes(hole))

    if (missing.length > 0 || unknown.length > 0) {
      return refuse(
        `the fuse of ${law.template} in ${one.rel} must bind exactly the holes ${law.params.join(', ')}${missing.length ? `: it leaves out ${missing.join(', ')}` : ''}${unknown.length ? `${missing.length ? ', and' : ':'} ${law.template} has no hole ${unknown.join(', ')}` : ''}.`,
        at,
      )
    }

    // each hole names the app's own form or task, defined in a file other than the one stating the law
    const elsewhere = new Set(files.filter(other => other.file !== one.file).flatMap(other => [...(defined.get(other.file) ?? [])]))
    const foreign = law.params.filter(param => !elsewhere.has(fill[param]!))

    if (foreign.length > 0) {
      return refuse(
        `${foreign.map(param => `\`bind ${param}, ${fill[param]}\``).join(', ')}: a hole names the app's own form or task, defined in a file other than ${one.rel} (code/model.tree), and ${foreign.map(param => fill[param]).join(', ')} is not. The law is about the app, not about something written beside it.`,
        at,
      )
    }

    // the claim the project makes, and the one the library's template makes alone with the same fill
    const role = input.roleOf(one.file) ?? undefined
    const lean = input.leanOf(one.file)
    const project = milled(one.file, one.text, role, lean)

    if (!project.ok) {
      return refuse(`${one.rel} could not be read, so ${name} could not be checked: ${project.error}`, at)
    }

    const claims = project.program.filter(s => isRule(s) && s.name === name)
    const reference = milled(law.file, `${law.text.trimEnd()}\n\n${fuseText(law, fill)}\n`, role, lean)
    const expected = reference.ok ? reference.program.find(s => isRule(s) && s.name === name) : undefined
    const english = sentenceOf(expected)

    if (!expected) {
      return refuse(`the library's ${name} could not be made with this fill${reference.ok ? '' : `: ${reference.error}`}`, at)
    }

    if (claims.length !== 1) {
      return refuse(
        claims.length === 0
          ? `${one.rel} fuses ${law.template} but holds no claim named ${name}: the library's text is appended below the marker before every round. Keep the fuse at the top level.`
          : `${one.rel} holds ${claims.length} claims named ${name}: only the fuse may make it.`,
        { ...at, ...(english ? { english } : {}) },
      )
    }

    if (shapeOf(claims[0]) !== shapeOf(expected)) {
      return refuse(
        `the claim named ${name} in ${one.rel} is not the library's ${name} with this fill.${english ? ` The library's says: ${english}` : ''}${sentenceOf(claims[0]) ? ` Yours says: ${sentenceOf(claims[0])}` : ''}`,
        { ...at, ...(english ? { english } : {}) },
      )
    }

    return { law: name, ok: true, ...at, ...(english ? { english } : {}) }
  })
}
