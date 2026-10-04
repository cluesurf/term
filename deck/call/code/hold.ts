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
import { preprocessTests } from '@term/call/code/test-preprocess'
import { renderDiagnostic } from '@term/call/code/report'
import { holdIncremental } from '@term/test/code/hold-incremental'
import {
  diskObligationCache,
  memoryObligationCache,
} from '@term/test/code/obligation-cache'
import { renderReport } from '@term/test/code/prove-file'
import { logGood, logFail, fade } from '@term/make/code/tint'

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

export function holdProject(root: string, files: string[]): HoldSummary {
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
    const source = readFileSync(file, 'utf8')
    const text = /^\s*test /m.test(source)
      ? preprocessTests(source).text
      : source
    const result = compile(
      { file, text },
      { resolve, cache, deckOf, roleOf, leanOf },
    )

    if (!result.ok) {
      failed.push(rel)

      for (const diagnostic of result.diagnostics) {
        console.error(
          renderDiagnostic(
            diagnostic,
            diagnostic.file === file ? text : undefined,
          ),
        )
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
        failures.push({
          // the ordinal counts every obligation of the kind in the task, proven or not, so proving one does not
          // renumber the rest
          key: `${base} ${failure.ordinal}`,
          message: failure.diagnostic.message,
          render: renderDiagnostic(failure.diagnostic, text),
        })
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

  if (files.length === 0) {
    logFail('No .tree files found')
    process.exit(1)
  }

  const summary = holdProject(root, files)

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
    console.log(
      fade(
        `  ${BASELINE}: ${keys.length} obligation(s), ${summary.fresh.length} added, ${summary.gone.length} removed`,
      ),
    )
    summary.baselined += summary.fresh.length
    summary.fresh = []
    summary.gone = []
  }

  if (input.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    for (const failure of summary.fresh) {
      console.error('\n' + failure.render)
    }

    const { ledger, kernel } = summary
    console.log(
      fade(
        `  kernel: ${kernel.proven} task(s) proven as one term, ${kernel.commands} checked statement by statement, ${kernel.declined} declined${
          kernel.reasons.length > 0
            ? ` (${kernel.reasons
                .slice(0, 4)
                .map(([reason, n]) => `${n} ${reason}`)
                .join('; ')})`
            : ''
        }`,
      ),
    )
    console.log(
      fade(
        `  trusted: ${ledger.native.length} impure task(s) (reach native code, are async, or have no body), ${ledger.axioms.length} axiom(s), ${ledger.unending.length} recursion(s) not shown to end, ${ledger.roaming.length} task(s) marked to run forever (mark roam), and one assumption: native code handed only scalars reaches no Term value`,
      ),
    )
    // the linear prover's refutations and the sum-of-squares provers' Gram matrices are replayed by a separate
    // checker; one the search found and the checker refused is reported unproven, and counted here because it is a
    // bug in the search (check/certificate.ts). Sturm and CAD are not certified, and the line says so
    console.log(
      fade(
        `  certified: every linear refutation and sum-of-squares certificate replayed by the checker, ${summary.uncertified} found by the search and refused. Sturm and CAD are trusted as written`,
      ),
    )

    if (ledger.axioms.length > 0) {
      console.log(fade(`  axioms: ${ledger.axioms.join(', ')}`))
    }

    if (summary.gone.length > 0) {
      console.log(
        fade(
          `  ${summary.gone.length} baselined obligation(s) now proven or gone: run \`term hold --commit\` to shrink ${BASELINE}`,
        ),
      )
    }
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

    for (const outcome of result.outcomes) {
      if (!outcome.ok && outcome.report) {
        console.log(renderReport(outcome.report))
      }
    }

    crossOk = result.ok
  }

  const line = `${summary.files} file(s), ${summary.proven} of ${summary.total} obligation(s) proven, ${summary.baselined} in the baseline`
  const problems = [
    summary.failed.length > 0
      ? `${summary.failed.length} file(s) do not hold: ${summary.failed.join(', ')}`
      : undefined,
    summary.open.length > 0
      ? `${summary.open.length} claim(s) open: ${summary.open.join(', ')}`
      : undefined,
    summary.fresh.length > 0
      ? `${summary.fresh.length} obligation(s) not proven and not in ${BASELINE}`
      : undefined,
    crossOk ? undefined : 'the cross-backend differential failed',
  ].filter((p): p is string => p !== undefined)

  if (problems.length === 0) {
    logGood(`Holds: ${line}`)
    process.exit(0)
  }

  logFail(`Does not hold: ${line}. ${problems.join('. ')}`)
  process.exit(1)
}
