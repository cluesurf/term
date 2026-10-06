// `term test`: every test file of a Term project compiled and run, or a package's own `test` script. It prints
// through the terminal output library (code/output.ts) as the standard's Test run card does: a `test` item per file
// with its counts, a `case` Problem item per test that did not hold, the compile problems of a file that did not
// build, and a closing item with the run's totals.
//
// What it decides without its file system, a build or the terminal is Term, in test-plan.tree: which files a run
// collects, a control's verdict, the counts a round closes with and what each refusal says.

import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { buildSession, projectResolver, watchTreeFiles } from '@term/call/code/make'
import { caseMatches, runTestFile, testsOf } from '@term/call/code/test-run'
import { missingTools, NATIVE_TEST_ENVS, runNativeTestFile } from '@term/call/code/test-native'
import type { NativeTestEnv } from '@term/call/code/test-native'
import { staleEntries } from '@term/make/code/compile/reach'
import type { TestUnits } from '@term/call/code/test-run'
import { projectCache, projectCacheDir } from '@term/call/code/cache-store'
import { projectDeckOf } from '@term/call/code/deck-of'
import { declaresDraft } from '@term/call/code/draft'
import { isSnapshotFile, readSnapshots, writeSnapshots } from '@term/call/code/test-snapshot'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { closeRun, count, failRun, field, location, openRun, outputOptions, report, reportProblems } from '@term/call/code/output'
import * as plan from '@term/call/code/test-plan'

export async function callTest(input: {
  root: string
  filter?: string
  // each test file compiled whole, the standard library checked again for every one, instead of through units
  merged?: boolean
  // run only the tests whose phrase or name holds this, in any case
  case?: string
  // the backend the tests run on: node (the default), rust, swift or kotlin
  env?: string
  // run, then run again on every edit the tests whose files the edit reaches, until ctrl-c
  ride?: boolean
  // write what each `want snapshot` sees, instead of holding it against the stored text
  update?: boolean
}): Promise<void> {
  try {
    const fs = await import('fs/promises')
    const path = await import('path')

    const isSeedProject = await hasDeckTree({ root: input.root })

    if (isSeedProject) {
      await runSeedTests({
        root: input.root,
        filter: input.filter,
        merged: input.merged,
        case: input.case,
        env: input.env,
        ride: input.ride,
        update: input.update,
      })

      return
    }

    const pkgJsonPath = path.join(input.root, 'package.json')

    let hasTestScript = false

    try {
      const pkgText = await fs.readFile(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(pkgText)
      hasTestScript = Boolean(pkg.scripts?.test)
    } catch {
      // no package.json
    }

    openRun({ verb: 'test', root: input.root, facts: input.filter ? [input.filter] : [] })

    if (!hasTestScript) {
      report({ glyph: 'failed', kind: 'problem', subject: 'There is no deck.tree here, and package.json has no test script' })
      closeRun({ verdict: 'Nothing to test', next: 'term wake, to make a Term project here' })

      return
    }

    const args = ['run', 'test']

    if (input.filter) {
      args.push('--', input.filter)
    }

    // the package's own test script: its output quoted under the `run` item when it failed or under --verbose
    // (section 15), or passed through untouched under --raw
    const started = Date.now()
    const run = await runScript(args, input.root, outputOptions().raw)
    report({
      glyph: run.code === 0 ? 'done' : 'failed',
      verb: 'run',
      subject: `pnpm ${args.join(' ')}`,
      duration: Date.now() - started,
      exit: run.code,
      quote: run.code === 0 && !outputOptions().verbose ? [] : run.lines,
    })
    closeRun({ verdict: run.code === 0 ? 'Tests passed' : 'Test run failed' })
  } catch (err) {
    failRun(err, input.root)
  }
}

// a package script run for its output, both streams, never rejecting. `raw` passes it through instead
function runScript(args: string[], cwd: string, raw: boolean): Promise<{ code: number; lines: string[] }> {
  return new Promise(resolve => {
    const child = spawn('pnpm', args, { cwd, stdio: raw ? 'inherit' : 'pipe', shell: true })
    const chunks: string[] = []
    child.stdout?.on('data', chunk => chunks.push(String(chunk)))
    child.stderr?.on('data', chunk => chunks.push(String(chunk)))
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 130 : 1), lines: chunks.join('').split('\n').filter(line => line !== '') }))
    child.on('error', error => resolve({ code: 127, lines: [String(error)] }))
  })
}

async function hasDeckTree(input: { root: string }): Promise<boolean> {
  const fs = await import('fs/promises')
  const path = await import('path')

  try {
    await fs.access(path.join(input.root, 'deck.tree'))

    return true
  } catch {
    return false
  }
}

// ---- controls ----

// build one control and say whether it was refused as its header expects (test-plan.tree `control-verdict-of`)
async function runControl(input: {
  file: string
  source: string
  // the package root, for the merged build's resolver
  root: string
  readRuntime: (path: string) => string | undefined
  roleOf: Parameters<typeof runTestFile>[0]['roleOf']
  leanOf: Parameters<typeof runTestFile>[0]['leanOf']
}): Promise<{
  held: boolean
  broken: boolean
  fact: string
  others: NonNullable<Awaited<ReturnType<typeof runTestFile>>['diagnostics']>
}> {
  const digits = plan.controlCount(input.source)

  if (digits === '') {
    return { ...plan.controlVerdictOf(digits, 0, false, [], []), others: [] }
  }

  const expected = Number(digits)
  // ALWAYS MERGED. A control is judged by how many refusals it gets, and the unit-at-a-time build reports fewer of a
  // file's diagnostics than it refuses: on 2026-10-05 it reported 2 for `vibe/group-control.tree`, whose 7 rules it
  // refuses one by one. Merged reports all 7 (tmp/control-debug-each.ts)
  const run = await runTestFile({
    file: input.file,
    source: input.source,
    resolve: projectResolver(input.root),
    env: 'node',
    readRuntime: input.readRuntime,
    roleOf: input.roleOf,
    leanOf: input.leanOf,
  })

  // a GOAL refused, counted once however many diagnostics say so: a false law citing a rule it is not an instance of is
  // refused at the `cite` and again as unproven, two diagnostics at one rule
  const diagnostics = run.failure ? (run.diagnostics ?? []) : []
  const verdict = plan.controlVerdictOf(
    digits,
    expected,
    Boolean(run.failure),
    diagnostics.map(d => d.name ?? ''),
    diagnostics.map(d => `${d.span?.file ?? ''}:${d.span?.start.line ?? ''}`),
  )

  return { ...verdict, others: verdict.broken ? diagnostics.filter(d => !plan.isRefusal(d.name ?? '')) : [] }
}

async function findTestFiles(input: {
  root: string
  filter?: string
}): Promise<string[]> {
  const fs = await import('fs/promises')
  const path = await import('path')
  const results: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        // `.base` whole: an entry is one folder name, so the toolchain's folder path under it never matched here
        if (entry.name === 'node_modules' || entry.name === '.base') {
          continue
        }

        // a shelved module (`draft.tree`) is out of the build, so its tests are out of the run too
        try {
          await fs.access(path.join(full, 'draft.tree'))
          continue
        } catch {
          // no marker: walk it
        }

        await walk(full)
      } else if (entry.name.endsWith('.tree') && !isSnapshotFile(entry.name)) {
        const text = await fs.readFile(full, 'utf-8')

        // likewise for a single shelved file, the answer the build walk gives (call/code/draft.ts)
        if (declaresDraft(text)) {
          continue
        }

        // a file is collected if it carries runnable tests (`test`) OR proof obligations (`hold` / `rule`), at any
        // indentation -- a `hold` inside a `task` states a UNIVERSAL law over the task's parameters (proved by the
        // linear prover for all values), not just a top-level closed witness. Both are verified by `term test`:
        // tests by running, proofs by the kernel and linear prover during compilation.
        if (plan.isCollected(text, full, input.filter ?? '')) {
          results.push(full)
        }
      }
    }
  }

  // a package keeps tests beside the code (`code/**`) and/or in its own `test` tree, which `deck.tree` declares as
  // `test ./test`. Walk both: a package that has a `code` dir still needs its `test` dir collected, and only when
  // NEITHER exists do we fall back to sweeping the whole root.
  const roots = ['code', 'test'].map(dir => path.join(input.root, dir))

  let walked = false

  for (const dir of roots) {
    try {
      await fs.access(dir)
    } catch {
      continue
    }

    await walk(dir)
    walked = true
  }

  if (!walked) {
    await walk(input.root)
  }

  return results
}

// what `run` prints to standard output and standard error, line by line, held back from the terminal while it runs
async function capturePrinted<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const chunks: string[] = []
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  const hold = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    return true
  }

  process.stdout.write = hold as typeof process.stdout.write
  process.stderr.write = hold as typeof process.stderr.write

  try {
    const value = await run()
    const lines = chunks.join('').split('\n')

    if (lines.at(-1) === '') {
      lines.pop()
    }

    return { value, lines }
  } finally {
    process.stdout.write = out
    process.stderr.write = err
  }
}

async function runSeedTests(input: {
  root: string
  filter?: string
  merged?: boolean
  case?: string
  env?: string
  ride?: boolean
  update?: boolean
}): Promise<void> {
  const path = await import('path')
  const fs = await import('fs/promises')
  let files = await findTestFiles({
    root: input.root,
    filter: input.filter,
  })
  const native = input.env && input.env !== 'node' ? (input.env as NativeTestEnv) : undefined

  openRun({
    verb: 'test',
    root: input.root,
    counts: [count(files.length, 'files', 'file')],
    facts: [
      ...(input.filter ? [input.filter] : []),
      ...(input.case ? [`case ${input.case}`] : []),
      ...(native ? [`on ${native}`] : []),
      ...(input.ride ? ['watching'] : []),
    ],
  })

  // a backend this command does not run on, and one whose toolchain this machine does not have, are said before
  // anything is built. The toolchain is asked after the backend is known to be one this command runs on
  const asked = plan.envRefusal(input.env ?? '', NATIVE_TEST_ENVS, input.update === true, [])
  const refusal = asked.subject === '' && native ? plan.envRefusal(input.env ?? '', NATIVE_TEST_ENVS, input.update === true, missingTools(native)) : asked

  if (refusal.subject !== '') {
    report({ glyph: 'failed', kind: 'problem', subject: refusal.subject })
    process.exitCode = closeRun({ verdict: 'Nothing was tested', failure: refusal.failure, ...(refusal.next ? { next: refusal.next } : {}) })

    return
  }

  if (files.length === 0 && !input.ride) {
    // a zero is data (section 6): the run says what it looked for and found none
    closeRun({ verdict: 'No tests to run', message: ['No file under code/ or test/ holds a test, a hold or a rule.'] })

    return
  }

  // the same role and lean readers `term make` compiles with, so a lean grammar's tests read it lean
  const roleOf = projectRoleOf(input.root)
  const leanOf = projectLeanOf(input.root)
  const deckOf = projectDeckOf()
  const readRuntime = (p: string): string | undefined =>
    existsSync(p) ? readFileSync(p, 'utf8') : undefined
  // one build session for every test file (note/term/plan/incremental-best-in-class.md, step 10): the units every file
  // reaches, the standard library's above all, are checked once for the run and read from the cache after that. Its
  // resolver checks each file it hands out against the disk once a round, so a watch reads every edit
  const session = buildSession(input.root)
  const units: TestUnits | undefined = input.merged
    ? undefined
    : {
        root: input.root,
        cache: projectCache(input.root),
        bundles: path.join(projectCacheDir(input.root), 'test'),
        deckOf,
        parsed: session.parsed,
        units: session.units,
        walked: session.walked,
      }

  // one round over the files given: every test file compiles and runs, so each `test` block executes and its
  // `want hold` / `want miss` is reported, not merely that the file compiled. The native runtime is read by the path
  // nativePrelude derives from each module's RESOLVED file, exactly as `term boot` runs compiled code
  const round = async (
    roundFiles: string[],
  ): Promise<{ pass: number; fail: number; proved: number; broken: number; skipped: number; controls: number }> => {
    // through units the session's resolver, which reads an edited file again; whole, a fresh one each round
    const resolve = units ? session.resolve : projectResolver(input.root)

    let pass = 0
    let fail = 0
    // files of laws alone, whose proofs the build checked
    let proved = 0
    // files that did not build, which ran no test at all
    let broken = 0
    // files holding no test `--case` asked for
    let skipped = 0
    // controls refused exactly as their headers expect (isControl)
    let controls = 0

    for (const file of roundFiles) {
      const rel = path.relative(input.root, file)
      const started = Date.now()

      try {
        const source = await fs.readFile(file, 'utf-8')

        // A CONTROL (a file under `test/case/`) is laws stated FALSE on purpose. It passes when the build refuses it,
        // and only for proof reasons, exactly as many times as its header says (`Expected: N`). A control that builds
        // means the provers accepted a false law. A control refused for any other reason (a typo, an unknown name) has
        // stopped testing anything, so it is broken rather than passed
        if (plan.isControl(rel)) {
          if (input.case || native) {
            skipped++
            continue
          }

          const verdict = await runControl({ file, source, root: input.root, readRuntime, roleOf, leanOf })

          if (verdict.broken) {
            broken++
            reportProblems(verdict.others.map(diagnostic => ({ diagnostic, text: diagnostic.file === file ? source : undefined })), input.root)
          } else if (verdict.held) {
            controls++
          } else {
            fail++
          }

          report({
            glyph: verdict.held ? 'done' : 'failed',
            verb: 'test',
            subject: rel,
            duration: Date.now() - started,
            facts: [verdict.fact],
          })
          continue
        }

        // the file's snapshots, held to or recorded (call/code/test-snapshot.ts). A store that cannot be read is the
        // file's failure, never an empty store, which would fail every snapshot as unwritten
        const store = readSnapshots(file)

        if ('problem' in store) {
          broken++
          report({ glyph: 'failed', verb: 'test', subject: rel, duration: Date.now() - started, facts: [store.problem] })
          continue
        }

        const snapshots = { stored: store.stored, update: input.update === true }
        const listed = testsOf(file, source, native ? { plainWants: true, snapshots } : { snapshots })
        const chosen = input.case ? listed.tests.filter(test => caseMatches(input.case!, test)) : listed.tests

        // `--case` runs the tests whose phrase or name holds it, so a file holding none of them is not run at all, and
        // a file of laws alone holds none
        if (input.case && chosen.length === 0) {
          skipped++
          continue
        }

        // what the file's tests print, quoted under its item: a test's `log` was written bare above the item, outside
        // the output standard (guides: tests/writing, 2026-10-05)
        const { value: run, lines: printed } = await capturePrinted(() =>
          native && chosen.length > 0
            ? runNativeTestFile({ root: input.root, file, text: listed.text, source, tests: chosen, env: native, roleOf, leanOf, deckOf })
            : runTestFile({
                file,
                source,
                resolve,
                env: 'node',
                readRuntime,
                roleOf,
                leanOf,
                units,
                snapshots,
                ...(input.case ? { select: (test: { name: string; label: string }) => caseMatches(input.case!, test) } : {}),
              }),
        )

        // under `--update`, the texts each test's `want snapshot`s saw replace the ones it had
        const recorded = input.update && run.taken ? writeSnapshots({ testFile: file, stored: store.stored, taken: run.taken, phrases: listed.tests.map(test => test.label) }) : undefined

        if (run.failure) {
          broken++
          // the compile diagnostics or the unproven holds, each a Problem item with its frame, not a bare "did not
          // compile", so a real error (an unknown name, an invalid proof) is visible
          reportProblems((run.diagnostics ?? []).map(diagnostic => ({ diagnostic, text: diagnostic.file === file ? run.text : undefined })), input.root)
          report({
            glyph: 'failed',
            verb: 'test',
            subject: rel,
            duration: Date.now() - started,
            facts: [plan.failureFact(run.failure)],
          })
          continue
        }

        const held = run.results.filter(one => one.held).length
        const missed = run.results.length - held

        // a proof-only file compiled clean, so its `hold` / `rule` proofs were kernel-checked. Counted as such, not as a
        // test: it added one to the tests, and a run of two tests and a file of laws closed `3 tests` (guides:
        // commands/test, 2026-10-04)
        if (run.results.length === 0) {
          proved++
          report({ glyph: 'done', verb: 'test', subject: rel, duration: Date.now() - started, facts: ['proofs checked'] })
          continue
        }

        pass += held
        fail += missed

        report({
          glyph: missed > 0 ? 'failed' : 'done',
          verb: 'test',
          subject: rel,
          duration: Date.now() - started,
          counts: [
            count(run.results.length, 'tests', 'test'),
            count(held, 'passed'),
            ...(missed > 0 ? [count(missed, 'failed')] : []),
            ...(recorded ? [count(recorded.written, 'snapshots written', 'snapshot written')] : []),
          ],
          ...(printed.length > 0 ? { quote: printed } : {}),
        })

        // each test that did not hold is a Problem of its own, under the verb `case` (section 9)
        for (const one of run.results.filter(each => !each.held)) {
          report({
            glyph: 'failed',
            kind: 'problem',
            verb: 'case',
            subject: plan.caseSubject(one.label),
            duration: one.ms,
            // where the test is, `file:line` of its `test` line as written (section 12), and what it threw
            fields: [one.line ? location(`${rel}:${one.line}`) : field('in', rel), ...(one.error ? [field('why', one.error)] : [])],
            place: one.line ? { path: rel, line: one.line, column: 1 } : undefined,
          })
        }
      } catch (err) {
        broken++
        report({ glyph: 'failed', verb: 'test', subject: rel, duration: Date.now() - started, message: [err instanceof Error ? err.message : String(err)] })
      }
    }

    session.close()

    return { pass, fail, proved, broken, skipped, controls }
  }

  const countsOf = (totals: plan.RoundTotals) => plan.totalsCounts(totals)

  // the session's first round: everything it was handed
  session.turn(files)
  const first = await round(files)

  if (!input.ride) {
    // `--case` that matched no test anywhere ran nothing, which is not a pass
    if (input.case && first.pass + first.fail === 0 && first.broken === 0) {
      process.exitCode = closeRun({
        verdict: 'No test matched',
        failure: 'usage',
        message: [`No test's phrase or name holds "${input.case}".`],
      })

      return
    }

    closeRun({ verdict: plan.roundFailed(first) ? 'Test run failed' : 'Tests passed', counts: countsOf(first) })

    return
  }

  // WATCH (`term test --ride`): after an edit, the test files whose closure holds a file that moved run again, and no
  // other. Which files moved is the session's to say (the stamp of every module a round walked), so a burst of saves
  // touching several files reruns everything any of them reaches. A test file added or removed, or a test file whose
  // closure the session cannot see (a round compiled whole, `--merged`), runs every file again. The run never closes
  // until ctrl-c: it is a stream, as `term make --ride` is
  report({ glyph: plan.roundFailed(first) ? 'failed' : 'done', verb: 'test', subject: 'every file', counts: countsOf(first) })

  process.once('SIGINT', () => {
    process.exit(closeRun({ verdict: 'Stopped', failure: 'interrupted', uptime: true }))
  })

  watchTreeFiles(input.root, async () => {
    files = await findTestFiles({ root: input.root, filter: input.filter })

    const moved = session.turn(files)
    const graph = new Map([...session.walked].map(([file, one]) => [file, one.edges]))
    // a round on a native backend, or one compiled whole, walks no closure the session can read
    const reached = moved === undefined || input.merged || native ? files : staleEntries(graph, files, moved)

    if (reached.length === 0) {
      return
    }

    const totals = await round(reached)
    report({
      glyph: plan.roundFailed(totals) ? 'failed' : 'done',
      verb: 'test',
      subject: plan.roundSubject(reached.length, files.length),
      counts: countsOf(totals),
    })
  })
}
