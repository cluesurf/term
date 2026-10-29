/**
 * `term hold --report`: the MVP report (note/project/term/assurance/mvp.md section 3), one page per run.
 *
 * The project's laws are named in `laws.tree` at its root, a data file (decision
 * note/project/term/proof/lean-export/decision/001-laws-manifest.md): one entry per law, its `name` and what proves
 * it, each by NAME only:
 *
 *   list law
 *     mesh
 *       host name, <ownership>
 *       list rule
 *         <ownership>, <ownership-of-replay>
 *     mesh
 *       host name, <no-forged-permit>
 *       host hide, <permit>
 *
 * `rule` names claims or theorems, `hide` and `sole` a form carrying that mark, `private` a task marked private, and
 * `tier` 0 is every tier-0 obligation. A claim the manifest does not name is a lemma, and is not a row.
 *
 * THE ENGLISH COMES FROM THE TERM FORM, never from the manifest: a rule through check/law-english.ts, a mark from the
 * mark and the definition, tier 0 from its kinds and the count. A law holds when what it names exists as named and
 * nothing the gate refused falls inside it: a diagnostic inside any definition its rules reach, the mark's own
 * refusal (`hidden-make`, `sole-reused`, `private-name`) naming it, or a tier-0 obligation not proven.
 */

import path from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parse } from '@term/make/code/parser/tree'
import { groupsOf } from '@term/make/code/parser/narrow'
import type { Node } from '@term/make/code/parser/tree'
import { headWord } from '@term/make/code/compile/mill-run'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import {
  expandData,
  readDataText,
  toJsonValue,
} from '@term/make/code/compile/host'
import { lawSentences } from '@term/make/code/check/law-english'
import type { LawSentence } from '@term/make/code/check/law-english'
import { readTree } from '@term/deck/code/package/read'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { projectHome } from '@term/call/code/home'
import type { HoldFound, HoldSummary } from '@term/call/code/hold'
import type { HoldLean } from '@term/call/code/hold-lean'

export const LAWS = 'laws.tree'

// what proves a law, as the manifest names it
type Proof = {
  kind: 'rule' | 'hide' | 'sole' | 'private' | 'tier'
  name: string
}

export type LawRow = {
  name: string
  // `rule ownership`, `hide permit`, `tier 0`
  proof: string[]
  holds: boolean
  // why it does not hold, the first reason found
  why?: string
  // each proof in words, from its Term form
  english: string[]
  // the outside calls (impure tasks) and axioms it rests on
  rests: string[]
}

export type HoldReport = {
  project: string
  commit: string
  date: string
  // the manifest was found and read
  manifest: boolean
  problems: string[]
  laws: LawRow[]
  obligations: { proven: number; total: number; baselined: number }
  contracts: number
  // every outside call taken as an axiom, and every axiom
  assumed: string[]
  notProven: number
  declined: number
  lean?: { checked: number; total: number }
  // the top line, without its glyph
  top: string
  holds: boolean
  // the page, as printed
  page: string
  // where the page was written
  file: string
}

type Definition = {
  name: string
  file: string
  start: number
  end: number
  statement: Record<string, unknown>
}

// every string a statement holds, outside its spans: the names it may reach
function wordsOf(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === 'string') {
    into.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) {wordsOf(item, into)}
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key !== 'span') {wordsOf(item, into)}
    }
  }

  return into
}

// the manifest's entries, read by the data reader: a list `law` of maps
function readLaws(
  root: string,
  problems: string[],
): { name: string; proofs: Proof[] }[] | undefined {
  const file = path.join(root, LAWS)

  if (!existsSync(file)) {
    return undefined
  }

  const read = readDataText({ file, text: readFileSync(file, 'utf8') })

  if (!read.ok) {
    problems.push(
      `${LAWS} does not read: ${read.diagnostics[0]?.message ?? 'not data'}`,
    )

    return []
  }

  const expanded = expandData(read.data, file)

  if (!expanded.ok) {
    problems.push(
      `${LAWS} does not read: ${expanded.diagnostics[0]?.message ?? 'not data'}`,
    )

    return []
  }

  const value = toJsonValue(expanded.data) as { law?: unknown }
  const entries = Array.isArray(value.law) ? value.law : []
  const texts = (v: unknown): string[] =>
    typeof v === 'string'
      ? [v]
      : typeof v === 'number'
        ? [String(v)]
        : Array.isArray(v)
          ? v.flatMap(texts)
          : []

  return entries.map((entry, index) => {
    const e = (entry ?? {}) as Record<string, unknown>
    const name = texts(e.name)[0] ?? `law ${index + 1}`
    const proofs: Proof[] = (
      ['rule', 'hide', 'sole', 'private', 'tier'] as const
    ).flatMap(kind => texts(e[kind]).map(one => ({ kind, name: one })))

    if (proofs.length === 0) {
      problems.push(`${LAWS}: ${name} names nothing that proves it`)
    }

    return { name, proofs }
  })
}

// `have`, `must` and `down` written on the project's tasks: the contracts
function contractsIn(file: string): number {
  const parsed = parse({ file, text: readFileSync(file, 'utf8') })

  if (!parsed.ok) {
    return 0
  }

  const count = (node: Node): number =>
    node.kind === 'group'
      ? (['have', 'must', 'down'].includes(headWord(node) ?? '')
          ? 1
          : 0) +
        node.nodes.reduce((sum, child) => sum + count(child), 0)
      : 0

  return groupsOf(parsed.tree.nodes)
    .filter(group => headWord(group) === 'task')
    .reduce(
      (sum, group) =>
        sum +
        group.nodes.reduce((inner, child) => inner + count(child), 0),
      0,
    )
}

function projectName(root: string): string {
  const file = path.join(root, 'deck.tree')

  if (existsSync(file)) {
    const read = readTree({ file, text: readFileSync(file, 'utf8') })
    const deck = read.ok
      ? read.forms.find(form => form.head === 'deck')
      : undefined

    if (deck?.terms[0]) {
      return deck.terms[0]
    }
  }

  return path.basename(root)
}

// the commit the project is at, read-only, `uncommitted` when its files differ from it
function commitOf(root: string): string {
  const head = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--short', 'HEAD'],
    { encoding: 'utf8' },
  )

  if (head.status !== 0) {
    return 'no commit'
  }

  const dirty = spawnSync(
    'git',
    ['-C', root, 'status', '--porcelain', '--', '.'],
    { encoding: 'utf8' },
  )

  return `${head.stdout.trim()}${dirty.stdout?.trim() ? ', with uncommitted changes' : ''}`
}

const TIER_ZERO =
  'every list read is inside its list, every division is by something other than zero, and every `walk test` ends'

export function holdReport(input: {
  root: string
  files: string[]
  summary: HoldSummary
  found: HoldFound
  lean?: HoldLean
}): HoldReport {
  const { root, files, summary, found } = input
  const problems: string[] = []
  const manifest = readLaws(root, problems)
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)

  // every top-level definition of the project, milled the way the build mills it, and every rule in words
  const definitions = new Map<string, Definition[]>()
  const sentences = new Map<string, LawSentence>()

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const parsed = parse({ file, text })

    if (!parsed.ok) {continue}

    const built = mill(
      expandTemplates(parsed.tree),
      file,
      roleOf(file) ?? undefined,
      leanOf(file),
    )

    if (!built.ok) {continue}

    for (const statement of built.program as unknown as Record<
      string,
      unknown
    >[]) {
      const name = statement.name
      const span = statement.span as
        | { start: { line: number }; end: { line: number } }
        | undefined

      if (typeof name === 'string' && span) {
        const list = definitions.get(name) ?? []
        list.push({
          name,
          file,
          start: span.start.line,
          end: span.end.line,
          statement,
        })
        definitions.set(name, list)
      }
    }

    for (const sentence of lawSentences(built.program)) {
      sentences.set(sentence.name, sentence)
    }
  }

  // what a definition reaches, itself included: every definition named anywhere inside it, transitively
  const reach = (name: string): Set<string> => {
    const seen = new Set<string>()
    const stack = [name]

    while (stack.length > 0) {
      const one = stack.pop()!

      if (seen.has(one) || !definitions.has(one)) {continue}

      seen.add(one)

      for (const definition of definitions.get(one)!) {
        for (const word of wordsOf(definition.statement, new Set())) {
          if (definitions.has(word) && !seen.has(word)) {stack.push(word)}
        }
      }
    }

    return seen
  }

  // the definition a refusal falls in
  const placeOf = (diagnostic: {
    file?: string
    span?: { start?: { line?: number } }
  }): string | undefined => {
    const file = diagnostic.file
      ? path.resolve(root, diagnostic.file)
      : undefined

    const line = diagnostic.span?.start?.line

    if (!file || line === undefined) {return undefined}

    for (const [name, list] of definitions) {
      if (
        list.some(
          d =>
            path.resolve(d.file) === file &&
            d.start <= line &&
            line <= d.end,
        )
      )
        {return name}
    }

    return undefined
  }

  const refusals = found.compile.map(problem => ({
    diagnostic: problem.diagnostic,
    at: placeOf(problem.diagnostic as never),
    where: `${path.relative(root, problem.diagnostic.file ?? '')}:${(problem.diagnostic.span?.start?.line ?? 0) + 1}`,
  }))

  // the outside calls and axioms of the ledger, `<file> <task>`, by task name
  const outside = new Map<string, string>()

  for (const entry of [
    ...summary.ledger.native,
    ...summary.ledger.axioms,
  ]) {
    outside.set(entry.slice(entry.lastIndexOf(' ') + 1), entry)
  }

  const fileOf = (name: string): string =>
    path.relative(root, definitions.get(name)?.[0]?.file ?? '')

  const statementOf = (
    name: string,
    form: string,
  ): Record<string, unknown> | undefined =>
    definitions.get(name)?.find(d => d.statement.form === form)
      ?.statement

  const laws: LawRow[] = (manifest ?? []).map(({ name, proofs }) => {
    const row: LawRow = {
      name,
      proof: proofs.map(p => `${p.kind} ${p.name}`),
      holds: true,
      english: [],
      rests: [],
    }

    const fail = (why: string): void => {
      if (row.holds) {
        row.holds = false
        row.why = why
      }
    }

    if (proofs.length === 0)
      {fail(`${LAWS} names nothing that proves it`)}

    for (const proof of proofs) {
      if (proof.kind === 'rule') {
        const sentence = sentences.get(proof.name)

        if (!sentence) {
          fail(`no rule named ${proof.name}`)
          continue
        }

        row.english.push(
          sentence.text ?? `(not rendered: ${sentence.refused})`,
        )

        if (sentence.kind === 'axiom') {
          row.rests.push(`axiom ${proof.name}`)
        }

        if (summary.open.includes(proof.name)) {
          fail(`${proof.name} is left open`)
        }

        const reached = reach(proof.name)
        const refused = refusals.find(
          r => r.at !== undefined && reached.has(r.at),
        )

        if (refused) {
          fail(
            `${refused.diagnostic.message} (${refused.at}, ${refused.where})`,
          )
        } else if (summary.failed.includes(fileOf(proof.name))) {
          fail(`${fileOf(proof.name)} does not compile`)
        }

        for (const one of reached) {
          const call = outside.get(one)

          if (call && !row.rests.includes(call)) {row.rests.push(call)}
        }
      } else if (proof.kind === 'tier') {
        row.english.push(
          `${TIER_ZERO}: ${summary.proven} of ${summary.total} obligations proven, ${summary.baselined} in the baseline`,
        )

        if (summary.fresh.length > 0) {
          fail(
            `${summary.fresh.length} tier-0 obligation${summary.fresh.length === 1 ? ' is' : 's are'} not proven: ${summary.fresh[0]!.message} (${summary.fresh[0]!.key})`,
          )
        }
      } else {
        const want =
          proof.kind === 'private' ? 'function' : 'record-type'

        const statement = statementOf(proof.name, want)
        const home = fileOf(proof.name)
        const words = {
          hide: `only ${home} makes a ${proof.name}`,
          sole: `a ${proof.name} is used at most once`,
          private: `only ${home} calls ${proof.name}`,
        }[proof.kind]

        const refusal = {
          hide: 'hidden-make',
          sole: 'sole-reused',
          private: 'private-name',
        }[proof.kind]

        if (!statement) {
          fail(
            `no ${want === 'function' ? 'task' : 'form'} named ${proof.name}`,
          )
          continue
        }

        if (statement[proof.kind] !== true) {
          fail(`${proof.name} is not \`mark ${proof.kind}\``)
          continue
        }

        row.english.push(words)

        const refused =
          refusals.find(
            r =>
              r.diagnostic.name === refusal &&
              r.diagnostic.message.includes(`"${proof.name}"`),
          ) ??
          refusals.find(
            r =>
              r.diagnostic.name === refusal &&
              r.diagnostic.message.includes(proof.name),
          )

        if (refused) {
          fail(`${refused.diagnostic.message} (${refused.where})`)
        } else if (summary.failed.includes(home)) {
          fail(`${home} does not compile`)
        }
      }
    }

    return row
  })

  if (manifest === undefined) {
    problems.push(
      `there is no ${LAWS} at the project root, so no law is named`,
    )
  }

  const held = laws.filter(law => law.holds).length
  const resting = laws.filter(law => law.rests.length > 0).length
  const contracts = files.reduce(
    (sum, file) => sum + contractsIn(file),
    0,
  )

  const notProven = new Set(
    summary.fresh.map(f => f.key.split(' ').slice(0, 2).join(' ')),
  ).size

  const lean =
    input.lean && !input.lean.missing
      ? {
          checked: input.lean.claims.filter(
            c => c.verdict === 'checked',
          ).length,
          total: input.lean.claims.length,
        }
      : undefined

  const holds =
    manifest !== undefined &&
    laws.length > 0 &&
    held === laws.length &&
    problems.length === 0 &&
    summary.failed.length === 0

  const top = [
    held === laws.length
      ? `${laws.length} law${laws.length === 1 ? '' : 's'} hold`
      : `${held} of ${laws.length} laws hold, ${laws.length - held} ${laws.length - held === 1 ? 'does' : 'do'} not (${laws
          .filter(l => !l.holds)
          .map(l => l.name)
          .join(', ')})`,
    `${summary.total} obligations`,
    `${contracts} contracts`,
    ...(summary.kernel.declined > 0
      ? [`${summary.kernel.declined} tasks declined by the kernel`]
      : []),
    ...(resting > 0
      ? [
          `${resting} law${resting === 1 ? ' rests' : 's rest'} on an outside call`,
        ]
      : []),
    ...(summary.failed.length > 0
      ? [
          `${summary.failed.length} file${summary.failed.length === 1 ? ' does' : 's do'} not compile`,
        ]
      : []),
    ...problems,
  ].join(', ')

  const project = projectName(root)
  const commit = commitOf(root)
  const date = new Date().toISOString().slice(0, 10)
  const width = Math.max(0, ...laws.map(law => law.name.length)) + 2

  const page = [
    `${project}  commit ${commit}  ${date}`,
    '',
    `${holds ? '✓' : '✗'} ${top}`,
    '',
    ...laws.flatMap(law => [
      `${law.name.padEnd(width)}${law.holds ? 'holds' : 'does not hold'}   rests on: ${law.rests.length > 0 ? law.rests.join(', ') : 'nothing'}`,
      ...(law.why ? [`  why: ${law.why}`] : []),
      `  proven by: ${law.proof.join(', ')}`,
      ...law.english.map(sentence => `  ${sentence}`),
      '',
    ]),
    'assumed (outside calls, each an axiom):',
    ...(outside.size > 0
      ? [...outside.values()].map(entry => `  ${entry}`)
      : ['  nothing']),
    '',
    `not proven: ${notProven} task${notProven === 1 ? '' : 's'}. declined by the kernel: ${summary.kernel.declined} task${summary.kernel.declined === 1 ? '' : 's'}`,
    ...(lean
      ? [`re-checked in Lean 4: ${lean.checked} of ${lean.total}`]
      : input.lean?.missing
        ? ['re-checked in Lean 4: not run, Lean is not installed']
        : []),
    '',
  ].join('\n')

  const file = projectHome(root, 'report', 'hold.txt')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, page)

  return {
    project,
    commit,
    date,
    manifest: manifest !== undefined,
    problems,
    laws,
    obligations: {
      proven: summary.proven,
      total: summary.total,
      baselined: summary.baselined,
    },
    contracts,
    assumed: [...outside.values()],
    notProven,
    declined: summary.kernel.declined,
    ...(lean ? { lean } : {}),
    top,
    holds,
    page,
    file,
  }
}
