/**
 * `term hold` - THE GATE. One command, one line, a non-zero exit while anything is unproven.
 *
 * It compiles every .tree file the way `term make` does, and refuses when:
 *
 *   - a file does not compile, which covers every error the checker raises: an unproven `hold`, an unproven
 *     contract (`have` / `must` / `down`), a proof the kernel did not verify, a claim filled by a looping or
 *     impure task, an unfilled claim;
 *   - a claim is left `mark open`, because an open claim is a promise and a gate cannot pass a promise;
 *   - a TIER-0 obligation fails that the project's baseline does not list. Tier 0 is what every task is proven free
 *     of with nothing written: every list read inside its list, every division by something other than zero. The
 *     baseline (`hold.json` at the project root) names what was already unproven the day the gate went up, and it
 *     may only shrink. `--commit` rewrites it to the current set, and the count of what that ADDED is printed, so a
 *     baseline cannot grow in silence.
 *
 * It also prints the TRUST LEDGER: what the proofs rest on that nothing here proves. Every task that reaches native
 * code, every axiom (`base true`), every task not shown to terminate.
 *
 * `--cross` additionally runs the cross-backend differential this command used to run by default (`@term/test`'s
 * incremental hold), which compares the backends rather than proving anything.
 *
 * See note/term/proof-by-default/readme.md and note/term/law-and-proof.md.
 */

import path from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { compile } from '@term/make/code/compile/compile'
import { withNativeEnv } from '@term/make/code/compile/native'
import { pureFunctions } from '@term/make/code/check/facts'
import type { Program } from '@term/make/code/compile/node'
import { findTreeFiles, projectResolver } from '@term/call/code/make'
import { collectTreeFiles } from '@term/call/code/files'
import { compilerVersion, projectCache } from '@term/call/code/cache-store'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { readable } from '@term/call/code/test-preprocess'
import { renderDiagnostic } from '@term/call/code/report'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { BuildProblem } from '@term/call/code/make'
import { holdIncremental } from '@term/test/code/hold-incremental'
import {
  diskObligationCache,
  memoryObligationCache,
} from '@term/test/code/obligation-cache'
import { renderReport } from '@term/test/code/prove-file'
import { closeRun, count, field, openRun, printData, problemOf, report, reportProblems } from '@term/call/code/output'

// where `holdProject` puts what it found, whole, for the caller to draw as Problem items: every diagnostic of a file
// that did not compile, and each failed tier-0 obligation by its key. It prints nothing itself
export type HoldFound = { compile: BuildProblem[]; obligations: Map<string, BuildProblem> }

// the baseline: the tier-0 obligations that were unproven when the gate went up, one key per obligation
type Baseline = { obligations: string[] }

const BASELINE = 'hold.json'

// one obligation's key: its file, its task, what it was owed for, and its ordinal among that task's obligations of
// that kind. No line number, so editing a file above a task does not churn the baseline.
type Failure = { key: string; message: string; render: string }

type Ledger = {
  native: string[]
  axioms: string[]
  unending: string[]
  // tasks marked `mark roam`: meant to run forever, so their walks owe no termination
  roaming: string[]
}

export type HoldSummary = {
  files: number
  failed: string[]
  open: string[]
  total: number
  proven: number
  baselined: number
  fresh: Failure[]
  gone: string[]
  ledger: Ledger
  // what the kernel did with the project's tasks: proved each as one term, checked it statement by statement, or
  // declined it, and the reasons it declined, most common first
  kernel: { proven: number; commands: number; declined: number; reasons: [string, number][] }
  // linear refutations found by the search and refused by the certificate checker, summed over every compile
  uncertified: number
}

function readBaseline(root: string): Baseline | undefined {
  const file = path.join(root, BASELINE)

  if (!existsSync(file)) {
    return undefined
  }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Baseline>

    return { obligations: parsed.obligations ?? [] }
  } catch {
    return { obligations: [] }
  }
}

// the tasks a compiled file owns. Every merged top-level node is stamped with its unit's file, and a task with no
// file was made by a pass, so it belongs to no file and is counted nowhere.
function ownTasks(program: Program, file: string) {
  return program.filter(
    (s): s is Extract<Program[number], { form: 'function' }> =>
      s.form === 'function' && !s.claim && !s.stub && s.span.file === file,
  )
}

export function holdProject(root: string, files: string[], found?: HoldFound): HoldSummary {
  const resolve = withNativeEnv('node', projectResolver(root))
  const cache = projectCache(root)
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)

  const failed: string[] = []
  const open = new Set<string>()
  const failures: Failure[] = []
  const ledger: Ledger = { native: [], axioms: [], unending: [], roaming: [] }
  let total = 0
  let proven = 0
  const kernel = { proven: 0, commands: 0, declined: 0 }
  const reasons = new Map<string, number>()
  let uncertified = 0

  for (const file of files) {
    const rel = path.relative(root, file)
    const unit = readable(readFileSync(file, 'utf8'))
    // a problem in this file, framed against the lines as written
    const placed = (diagnostic: Diagnostic): string => {
      const at = unit.place(diagnostic)

      return renderDiagnostic(at.diagnostic, at.text)
    }
    const framed = (diagnostic: Diagnostic): BuildProblem =>
      diagnostic.file === file ? unit.place(diagnostic) : { diagnostic, text: undefined }
    const result = compile(
      { file, text: unit.text },
      { resolve, cache, deckOf, roleOf, leanOf },
    )

    if (!result.ok) {
      failed.push(rel)

      for (const diagnostic of result.diagnostics) {
        found?.compile.push(framed(diagnostic))
      }

      continue
    }

    for (const claim of result.openClaims ?? []) {
      open.add(claim)
    }

    uncertified += result.uncertified ?? 0

    if (result.kernel) {
      kernel.proven += result.kernel.proven
      kernel.commands += result.kernel.commands
      kernel.declined += result.kernel.declined.length

      for (const { reason } of result.kernel.declined) {
        // a kernel type error carries its own detail; count it under its kind
        const kind = reason.startsWith('a kernel type error')
          ? 'a kernel type error'
          : reason
        reasons.set(kind, (reasons.get(kind) ?? 0) + 1)
      }
    }

    const tally = result.obligations

    if (tally) {
      total += tally.total
      proven += tally.proven

      for (const failure of tally.failed) {
        const base = `${rel} ${failure.task} ${failure.origin}`
        // the ordinal counts every obligation of the kind in the task, proven or not, so proving one does not
        // renumber the rest
        const key = `${base} ${failure.ordinal}`
        failures.push({
          key,
          message: failure.diagnostic.message,
          render: placed(failure.diagnostic),
        })
        found?.obligations.set(key, framed(failure.diagnostic))
      }
    }

    // the trust ledger, from what this file owns
    if ('program' in result && result.program) {
      const own = ownTasks(result.program, file)
      const pure = pureFunctions(result.program)

      for (const task of own) {
        const name = task.method
          ? `${task.method.form}/${task.method.name}`
          : task.name

        if (task.roam) {
          ledger.roaming.push(`${rel} ${name}`)
        }

        if (task.axiom) {
          ledger.axioms.push(`${rel} ${name}`)
        } else if (!pure.has(task.name)) {
          ledger.native.push(`${rel} ${name}`)
        }
      }

      for (const warning of result.warnings) {
        if (
          warning.name === 'non-terminating' &&
          (warning.file === file || warning.file === undefined)
        ) {
          ledger.unending.push(`${rel}:${warning.span.start.line + 1}`)
        }
      }
    }
  }

  const baseline = readBaseline(root)
  const known = new Set(baseline?.obligations ?? [])
  const current = new Set(failures.map(f => f.key))

  return {
    files: files.length,
    failed,
    open: [...open].sort(),
    total,
    proven,
    baselined: failures.filter(f => known.has(f.key)).length,
    fresh: failures.filter(f => !known.has(f.key)),
    gone: [...known].filter(key => !current.has(key)).sort(),
    ledger,
    kernel: {
      ...kernel,
      reasons: [...reasons].sort((a, b) => b[1] - a[1]),
    },
    uncertified,
  }
}

export async function callHold(input: {
  root: string
  paths: string[]
  cross?: boolean
  cache?: boolean
  force?: boolean
  json?: boolean
  commit?: boolean
}): Promise<void> {
  const { root } = input
  // the same files `term make` compiles for node, so the gate and the build agree on what the project is: another
  // platform's native trees are not part of a node build, and do not compile in one
  const files =
    input.paths.length > 0
      ? await collectTreeFiles(input.paths, root)
      : findTreeFiles(root, [], 'node')

  openRun({ verb: 'hold', root, counts: [count(files.length, 'files', 'file')], facts: input.commit ? ['--commit'] : [] })

  if (files.length === 0) {
    report({ glyph: 'failed', kind: 'problem', subject: 'There is no .tree file to hold', message: input.paths.length ? [`Looked in ${input.paths.join(', ')}.`] : [] })
    process.exit(closeRun({ verdict: 'Nothing to hold' }))
  }

  const found: HoldFound = { compile: [], obligations: new Map() }
  const summary = holdProject(root, files, found)

  // every file that does not compile, each diagnostic a Problem item with its frame: the checker's errors are the
  // unproven holds and contracts, the unverified proofs and the unfilled claims
  reportProblems(found.compile, root)

  if (input.commit) {
    const keys = [
      ...new Set([
        ...(readBaseline(root)?.obligations ?? []).filter(
          key => !summary.gone.includes(key),
        ),
        ...summary.fresh.map(f => f.key),
      ]),
    ].sort()

    writeFileSync(
      path.join(root, BASELINE),
      JSON.stringify({ obligations: keys }, null, 2) + '\n',
    )
    // the count of what the commit ADDED is printed, so a baseline cannot grow in silence
    report({
      glyph: 'changed',
      kind: 'change',
      verb: 'commit',
      subject: BASELINE,
      counts: [
        count(keys.length, 'obligations', 'obligation'),
        count(summary.fresh.length, 'added'),
        count(summary.gone.length, 'removed'),
      ],
    })
    summary.baselined += summary.fresh.length
    summary.fresh = []
    summary.gone = []
  }

  // the summary is data the user asked for, on stdout, the same object it always was
  if (input.json) {
    printData(JSON.stringify(summary, null, 2) + '\n')
  }

  // each tier-0 obligation that is not proven and not in the baseline, a Problem item under `prove` (section 12)
  for (const failure of summary.fresh) {
    const placed = found.obligations.get(failure.key)

    if (placed) {
      report({ ...problemOf(placed.diagnostic, root, placed.text), verb: 'prove' })
    } else {
      report({ glyph: 'failed', kind: 'problem', verb: 'prove', subject: failure.message, facts: [failure.key] })
    }
  }

  const { ledger, kernel } = summary

  report({
    glyph: 'info',
    verb: 'prove',
    subject: 'What the kernel did with the tasks',
    counts: [
      count(kernel.proven, 'proven as one term'),
      count(kernel.commands, 'checked statement by statement'),
      count(kernel.declined, 'declined'),
    ],
    // one line per reason, most common first: `An expression the kernel cannot represent: 1`
    message: kernel.reasons.slice(0, 4).map(([reason, n]) => `${reason.charAt(0).toUpperCase()}${reason.slice(1)}: ${n.toLocaleString('en-US')}`),
  })

  // the TRUST LEDGER: what the proofs rest on that nothing here proves
  report({
    glyph: 'info',
    verb: 'trust',
    subject: 'What the proofs rest on and nothing here proves',
    counts: [
      count(ledger.native.length, 'impure tasks', 'impure task'),
      count(ledger.axioms.length, 'axioms', 'axiom'),
      count(ledger.unending.length, 'recursions not shown to end', 'recursion not shown to end'),
      count(ledger.roaming.length, 'marked roam'),
    ],
    message: ['An impure task reaches native code, is async, or has no body. One assumption: native code handed only scalars reaches no Term value.'],
    fields: ledger.axioms.length > 0 ? [field('axioms', ledger.axioms.join(', '))] : [],
  })

  // the linear prover's refutations and the sum-of-squares provers' Gram matrices are replayed by a separate
  // checker; one the search found and the checker refused is reported unproven, and counted here because it is a
  // bug in the search (check/certificate.ts). Sturm and CAD are not certified, and the item says so
  report({
    glyph: summary.uncertified > 0 ? 'warning' : 'info',
    verb: 'certify',
    subject: 'Every linear refutation and sum-of-squares certificate replayed by the checker',
    counts: [count(summary.uncertified, 'found by the search and refused')],
    message: ['Sturm and CAD are trusted as written.'],
  })

  if (summary.gone.length > 0) {
    report({
      glyph: 'info',
      verb: 'hold',
      subject: `${summary.gone.length} baselined obligation${summary.gone.length === 1 ? ' is' : 's are'} now proven or gone`,
      fields: [field('next', `term hold --commit, to shrink ${BASELINE}`)],
    })
  }

  // an open claim is a promise, and a gate cannot pass a promise
  if (summary.open.length > 0) {
    report({
      glyph: 'failed',
      kind: 'problem',
      verb: 'prove',
      subject: `${summary.open.length} claim${summary.open.length === 1 ? ' is' : 's are'} left open`,
      message: [summary.open.join(', ')],
    })
  }

  // the cross-backend differential, when asked for, after the proof gate
  let crossOk = true

  if (input.cross) {
    const result = holdIncremental({
      files,
      resolve: projectResolver(root, 'node', root),
      cache:
        input.cache === false
          ? memoryObligationCache()
          : diskObligationCache(path.join(root, '.base/@cluesurf/term', 'hold')),
      version: compilerVersion(),
      cross: true,
      force: input.force,
    })

    // a backend that disagrees is a ✗ item, the differential's own report quoted under it
    for (const outcome of result.outcomes) {
      if (!outcome.ok && outcome.report) {
        report({ glyph: 'failed', kind: 'problem', verb: 'cross', subject: 'The backends disagree', quote: renderReport(outcome.report).split('\n') })
      }
    }

    crossOk = result.ok

    if (crossOk) {
      report({ glyph: 'done', verb: 'cross', subject: 'Every backend agrees', counts: [count(files.length, 'files', 'file')] })
    }
  }

  const holds = summary.failed.length === 0 && summary.open.length === 0 && summary.fresh.length === 0 && crossOk
  const counts = [
    count(summary.proven, 'obligations proven', 'obligation proven', summary.total),
    count(summary.baselined, 'in the baseline'),
    ...(summary.failed.length > 0 ? [count(summary.failed.length, 'files do not hold', 'file does not hold')] : []),
    ...(summary.fresh.length > 0 ? [count(summary.fresh.length, `not proven and not in ${BASELINE}`)] : []),
  ]

  // a gate that passed says so with a ✓ of its own: the items above are `·` summaries, and a run of `·` items closes
  // `·` (section 4), which reads as "nothing was done" for the one command whose whole job is a verdict
  if (holds) {
    report({ glyph: 'done', verb: 'prove', subject: 'Every obligation is proven or in the baseline', counts: [count(summary.proven, 'proven', '', summary.total)] })
  }

  // THE GATE: exit 0 when everything holds, 1 when anything does not. Exits at once, as it always has
  process.exit(closeRun({ verdict: holds ? 'Holds' : 'Does not hold', counts }))
}
