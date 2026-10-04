// `term test`: every test file of a Term project compiled and run, or a package's own `test` script. It prints
// through the terminal output library (code/output.ts) as the standard's Test run card does: a `test` item per file
// with its counts, a `case` Problem item per test that did not hold, the compile problems of a file that did not
// build, and a closing item with the run's totals.

import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { projectResolver } from '@term/call/code/make'
import { runTestFile } from '@term/call/code/test-run'
import { declaresDraft } from '@term/call/code/draft'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { closeRun, count, failRun, field, location, openRun, outputOptions, report, reportProblems } from '@term/call/code/output'

export async function callTest(input: {
  root: string
  filter?: string
}): Promise<void> {
  try {
    const fs = await import('fs/promises')
    const path = await import('path')

    const isSeedProject = await hasDeckTree({ root: input.root })

    if (isSeedProject) {
      await runSeedTests({ root: input.root, filter: input.filter })

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
        if (entry.name === 'node_modules' || entry.name === '.base/@cluesurf/term') {
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
      } else if (entry.name.endsWith('.tree')) {
        const text = await fs.readFile(full, 'utf-8')

        // likewise for a single shelved file, the answer the build walk gives (call/code/draft.ts)
        if (declaresDraft(text)) {
          continue
        }

        // a file is collected if it carries runnable tests (`test`) OR proof obligations (`hold` / `rule`), at any
        // indentation -- a `hold` inside a `task` states a UNIVERSAL law over the task's parameters (proved by the
        // linear prover for all values), not just a top-level closed witness. Both are verified by `term test`:
        // tests by running, proofs by the kernel and linear prover during compilation.
        if (/^\s*(test|hold|rule) /m.test(text)) {
          if (input.filter) {
            if (
              full.includes(input.filter) ||
              text.includes(input.filter)
            ) {
              results.push(full)
            }
          } else {
            results.push(full)
          }
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

async function runSeedTests(input: {
  root: string
  filter?: string
}): Promise<void> {
  const path = await import('path')
  const fs = await import('fs/promises')
  const files = await findTestFiles({
    root: input.root,
    filter: input.filter,
  })

  openRun({
    verb: 'test',
    root: input.root,
    counts: [count(files.length, 'files', 'file')],
    facts: input.filter ? [input.filter] : [],
  })

  if (files.length === 0) {
    // a zero is data (section 6): the run says what it looked for and found none
    closeRun({ verdict: 'No tests to run', message: ['No file under code/ or test/ holds a test, a hold or a rule.'] })

    return
  }

  // every test file compiles and runs in-process with the project resolver, so each `test` block executes and its
  // `want hold` / `want miss` assertion is reported, not merely that the file compiled. The native runtime is read by
  // the path nativePrelude derives from each module's RESOLVED file (the `term link` / import location), not a
  // hardcoded base.tree path, exactly as `term boot` runs compiled code.
  const resolve = projectResolver(input.root)
  // the same role and lean readers `term make` compiles with, so a lean grammar's tests read it lean
  const roleOf = projectRoleOf(input.root)
  const leanOf = projectLeanOf(input.root)
  const readRuntime = (p: string): string | undefined =>
    existsSync(p) ? readFileSync(p, 'utf8') : undefined

  let pass = 0
  let fail = 0
  // files that did not build, which ran no test at all
  let broken = 0

  for (const file of files) {
    const rel = path.relative(input.root, file)
    const started = Date.now()

    try {
      const source = await fs.readFile(file, 'utf-8')
      const run = await runTestFile({
        file,
        source,
        resolve,
        env: 'node',
        readRuntime,
        roleOf,
        leanOf,
      })

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
          facts: [run.failure.split('\n').pop() ?? 'did not compile'],
        })
        continue
      }

      const held = run.results.filter(one => one.held).length
      const missed = run.results.length - held

      // a proof-only file compiled clean, so its `hold` / `rule` proofs were kernel-checked: one check, held
      if (run.results.length === 0) {
        pass++
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
        counts: [count(run.results.length, 'tests', 'test'), count(held, 'passed'), ...(missed > 0 ? [count(missed, 'failed')] : [])],
      })

      // each test that did not hold is a Problem of its own, under the verb `case` (section 9)
      for (const one of run.results.filter(each => !each.held)) {
        report({
          glyph: 'failed',
          kind: 'problem',
          verb: 'case',
          subject: one.label.charAt(0).toUpperCase() + one.label.slice(1),
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

  const counts = [count(pass + fail, 'tests', 'test'), count(pass, 'passed'), ...(fail > 0 ? [count(fail, 'failed')] : [])]

  if (broken > 0) {
    counts.push(count(broken, 'files did not build', 'file did not build'))
  }

  closeRun({ verdict: fail > 0 || broken > 0 ? 'Test run failed' : 'Tests passed', counts })
}
