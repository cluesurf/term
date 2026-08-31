import { existsSync, readFileSync } from 'node:fs'
import {
  logGood,
  logFail,
  logStep,
  formatError,
  fade,
} from '@term/make/code/tint'
import { runCommand, projectResolver } from '@term/call/code/make'
import { runTestFile } from '@term/call/code/test-run'

export async function callTest(input: {
  root: string
  filter?: string
}): Promise<void> {
  logStep('Running tests...')

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

    if (hasTestScript) {
      const args = ['run', 'test']

      if (input.filter) {
        args.push('--', input.filter)
      }

      await runCommand({ cmd: 'pnpm', args, cwd: input.root })
      logGood('Tests complete')
    } else {
      logFail('No test script found in package.json')
      process.exit(1)
    }
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
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

        // likewise for a single shelved file
        if (/^note draft\s*$/m.test(text.slice(0, 2000))) {
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

  if (files.length === 0) {
    console.log(fade('  No test files found.'))
    logGood('No tests to run')

    return
  }

  console.log(
    fade(
      `  Found ${files.length} test file${
        files.length === 1 ? '' : 's'
      }`,
    ),
  )

  // every test file compiles and runs in-process with the project resolver, so each `test` block executes and its
  // `want hold` / `want miss` assertion is reported, not merely that the file compiled. The native runtime is read by
  // the path nativePrelude derives from each module's RESOLVED file (the `term link` / import location), not a
  // hardcoded base.tree path, exactly as `term boot` runs compiled code.
  const resolve = projectResolver(input.root)
  const readRuntime = (p: string): string | undefined =>
    existsSync(p) ? readFileSync(p, 'utf8') : undefined

  let pass = 0
  let fail = 0

  for (const file of files) {
    const rel = path.relative(input.root, file)
    console.log(fade(`  ${rel}`))

    try {
      const source = await fs.readFile(file, 'utf-8')
      const run = await runTestFile({
        file,
        source,
        resolve,
        env: 'node',
        readRuntime,
      })

      if (run.failure) {
        fail++
        // show the full failure (the compile diagnostics or the unproven-hold detail), not just its last line, so a
        // real error (an unknown name, an invalid proof) is visible rather than a bare "did not compile"
        logFail(
          run.failure
            .split('\n')
            .map(line => `    ${line}`)
            .join('\n'),
        )
        continue
      }

      if (run.results.length === 0) {
        // a proof-only file: it compiled clean, so its `hold` / `rule` proofs were kernel-checked
        pass++
        console.log(`    ${fade('ok')}  proofs checked`)
      }

      for (const r of run.results) {
        if (r.held) {
          pass++
          console.log(`    ${fade('ok')}  ${r.label}`)
        } else {
          fail++
          logFail(`    ${r.label}`)
        }
      }
    } catch (err) {
      fail++
      logFail(`    ${formatError(err)}`)
    }
  }

  console.log()

  if (fail > 0) {
    logFail(`${fail} failed, ${pass} passed`)
    process.exit(1)
  } else {
    logGood(`${pass} test${pass === 1 ? '' : 's'} passed`)
  }
}
