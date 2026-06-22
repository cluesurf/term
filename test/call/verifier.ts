// The agent-facing CLI: `seed scan` (the JSON verifier) and `seed mind` (project memory). Drives the real CLI through
// tsx in a temp workspace and checks the structured output + exit codes. Run: npx tsx test/call/verifier.ts

import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEED_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)
const LINE = join(SEED_ROOT, 'deck', 'call', 'code', 'line.ts')
const TSCONFIG = join(SEED_ROOT, 'tsconfig.json')

let pass = 0
let fail = 0
function expect(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

// run the seed CLI; return its stdout (clean JSON when `--back json`) and exit status
function seed(
  args: string[],
  cwd: string,
): { stdout: string; status: number } {
  try {
    // run from the temp workspace (so the CLI's `root` is the temp dir), but point tsx at the seed tsconfig so the
    // `@cluesurf/*` path mappings still resolve (they are relative to the tsconfig's own directory)
    const stdout = execFileSync('npx', ['tsx', LINE, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG },
    })
    return { stdout, status: 0 }
  } catch (e: unknown) {
    const err = e as { stdout?: string; status?: number }
    return { stdout: err.stdout ?? '', status: err.status ?? 1 }
  }
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'seed-cli-'))

  // scan: a clean file is ok, exit 0, no diagnostics
  writeFileSync(
    join(dir, 'good.tree'),
    'task double\n  take value, like number\n  like number\n  send back\n    call add\n      read value\n      read value\n',
  )
  const good = seed(['scan', 'good.tree', '--back', 'json'], dir)
  const goodJson = JSON.parse(good.stdout.trim())
  expect(
    'scan: clean file -> ok:true, exit 0, no diagnostics',
    good.status === 0 &&
      goodJson.ok === true &&
      goodJson.diagnostics.length === 0,
  )

  // scan: a type error fails, exit 1, with a structured diagnostic (code + name + span)
  writeFileSync(
    join(dir, 'bad.tree'),
    'task wrong\n  take b, like boolean\n  like number\n  send back\n    call add\n      read b\n      code 1\n',
  )
  const bad = seed(['scan', 'bad.tree', '--back', 'json'], dir)
  const badJson = JSON.parse(bad.stdout.trim())
  expect(
    'scan: type error -> ok:false, exit 1, structured diagnostic',
    bad.status === 1 &&
      badJson.ok === false &&
      badJson.diagnostics[0]?.name === 'type-mismatch' &&
      typeof badJson.diagnostics[0]?.code === 'number' &&
      !!badJson.diagnostics[0]?.span?.start,
  )

  // mind: remember then recall, and write the store under .seed/memory
  seed(
    ['mind', 'The kernel is the type authority.', '--kind', 'decision'],
    dir,
  )
  const recall = seed(
    ['mind', '--find', 'kernel', '--back', 'json'],
    dir,
  )
  const recallJson = JSON.parse(recall.stdout.trim())
  expect(
    'mind: remembers a fact and recalls it by query',
    recallJson.ok === true &&
      recallJson.facts.length === 1 &&
      recallJson.facts[0]?.kind === 'decision',
  )
  expect(
    'mind: writes the store under .seed/memory',
    existsSync(join(dir, '.seed', 'memory', 'index.md')) &&
      readFileSync(
        join(dir, '.seed', 'memory', 'index.md'),
        'utf8',
      ).includes('Memory'),
  )

  console.log(`\nverifier: ${pass} pass, ${fail} fail`)
  if (fail) process.exit(1)
}

main()
