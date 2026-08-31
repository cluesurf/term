/**
 * `seed hold` - the verification CLI verb. "Hold" is the kernel's word
 * for a verified property: a goal `show hold`s, and a passing proof
 * holds. `seed hold [paths..]` asks whether the files hold - it compiles
 * each Seed file, reports every verification gap (the checker's
 * diagnostics as structured, actionable items), optionally runs the
 * cross-backend differential, and exits non-zero so it gates CI.
 *
 * It is INCREMENTAL: a per-project obligation cache (under `.base/@cluesurf/term/hold`)
 * skips any file whose content - and the content of every module it
 * loads, and the toolchain version - is unchanged since it last held.
 * The first run checks everything; later runs only re-check what moved.
 * `--force` re-checks everything; `--no-cache` disables persistence.
 *
 * The verification engine lives in `@cluesurf/test`. This verb owns only
 * the project resolver (which lives in `call`), the file collection, and
 * the process glue, then delegates to `holdIncremental` / `proveFile`.
 */

import path from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { collectTreeFiles } from '@term/call/code/files'
import { compilerVersion } from '@term/call/code/cache-store'
import { holdIncremental } from '@term/test/code/hold-incremental'
import {
  diskObligationCache,
  memoryObligationCache,
} from '@term/test/code/obligation-cache'
import { renderReport } from '@term/test/code/prove-file'
import { logGood, logFail, fade } from '@term/make/code/tint'

export async function callHold(input: {
  root: string
  paths: string[]
  cross?: boolean
  cache?: boolean
  force?: boolean
  json?: boolean
}): Promise<void> {
  const { root } = input
  const cross = input.cross ?? true
  const useCache = input.cache ?? true

  const files = await collectTreeFiles(input.paths, root)

  if (files.length === 0) {
    logFail('No .tree files found')
    process.exit(1)
  }

  const resolve = projectResolver(root, 'node', root)
  const cache = useCache
    ? diskObligationCache(path.join(root, '.base/@cluesurf/term', 'hold'))
    : memoryObligationCache()

  const result = holdIncremental({
    files,
    resolve,
    cache,
    version: compilerVersion(),
    cross,
    force: input.force,
  })

  if (input.json) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 1)
  }

  for (const outcome of result.outcomes) {
    const rel = path.relative(root, outcome.file)

    if (outcome.source === 'cached') {
      console.log(
        fade(`  cached  ${rel}  ${outcome.ok ? 'holds' : 'FAILED'}`),
      )
      continue
    }

    // a freshly-checked failure prints the full gap report
    if (!outcome.ok && outcome.report) {
      console.log(renderReport(outcome.report))
    } else {
      console.log(fade(`  checked ${rel}  holds`))
    }
  }

  console.log(
    fade(
      `  ${result.checked} checked, ${result.cached} cached, ${result.outcomes.length} total`,
    ),
  )

  if (result.ok) {
    logGood('Holds')
    process.exit(0)
  } else {
    logFail('Verification failed')
    process.exit(1)
  }
}
