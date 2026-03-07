import { logGood, logFail, logStep, formatError, fade } from '../tint'
import { runCommand } from './make'

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

async function hasDeckTree(input: {
  root: string
}): Promise<boolean> {
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
}): Promise<Array<string>> {
  const fs = await import('fs/promises')
  const path = await import('path')
  const results: Array<string> = []

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.seed') {
          continue
        }
        await walk(full)
      } else if (entry.name.endsWith('.tree')) {
        const text = await fs.readFile(full, 'utf-8')
        if (/^test /m.test(text)) {
          if (input.filter) {
            if (full.includes(input.filter) || text.includes(input.filter)) {
              results.push(full)
            }
          } else {
            results.push(full)
          }
        }
      }
    }
  }

  const codeDir = path.join(input.root, 'code')
  try {
    await fs.access(codeDir)
    await walk(codeDir)
  } catch {
    await walk(input.root)
  }

  return results
}

async function runSeedTests(input: {
  root: string
  filter?: string
}): Promise<void> {
  const path = await import('path')
  const files = await findTestFiles({
    root: input.root,
    filter: input.filter,
  })

  if (files.length === 0) {
    console.log(fade('  No test files found.'))
    logGood('No tests to run')
    return
  }

  console.log(fade(`  Found ${files.length} test file${files.length === 1 ? '' : 's'}`))

  let passed = 0
  let failed = 0
  let errors: Array<{ file: string; error: string }> = []

  for (const file of files) {
    const rel = path.relative(input.root, file)
    try {
      console.log(fade(`  ${rel}`))
      await runCommand({
        cmd: 'seed',
        args: ['make', file],
        cwd: input.root,
      })
      passed++
    } catch (err) {
      failed++
      errors.push({
        file: rel,
        error: formatError(err),
      })
    }
  }

  console.log()
  if (failed > 0) {
    for (const e of errors) {
      logFail(`${e.file}: ${e.error}`)
    }
    logFail(`${failed} of ${passed + failed} test files failed`)
    process.exit(1)
  } else {
    logGood(`${passed} test file${passed === 1 ? '' : 's'} passed`)
  }
}
