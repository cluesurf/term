// Dev harness for a single `.tree` test file. A thin wrapper over the shared runner (code/call/test-run.ts), the same
// one `seed test` uses, so the dev path and the CLI path are identical: same compile, same in-process execution, same
// native-runtime reading via each module's RESOLVED file (the `seed link` / import location, not a hardcoded path).
// Run: npx tsx test/tree/run.ts <file>. See note/library/seed/test-dsl.md.

import { readFileSync, existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { runTestFile } from '@/code/call/test-run'
import { projectResolver } from '@/code/call/make'

async function runFile(file: string): Promise<number> {
  const run = await runTestFile({
    file,
    source: readFileSync(file, 'utf8'),
    resolve: projectResolver(process.cwd()),
    env: 'node',
    readRuntime: p => (existsSync(p) ? readFileSync(p, 'utf8') : undefined),
  })
  if (run.failure) {
    console.log(run.failure)
    console.log(`\n${file}: ${run.failure.split('\n').pop()}`)
    return 1
  }
  let pass = 0
  let fail = 0
  for (const r of run.results) {
    if (r.held) {
      pass++
      console.log(`ok    ${r.label}`)
    } else {
      fail++
      console.log(`FAIL  ${r.label}`)
    }
  }
  console.log(`\n${pass} pass, ${fail} fail`)
  return fail > 0 ? 1 : 0
}

const target = process.argv[2]
if (!target) {
  console.log('usage: npx tsx test/tree/run.ts <file.tree>')
  process.exit(2)
}
process.exit(await runFile(resolvePath(target)))
