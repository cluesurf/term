// Key trust in term:test: deck/deck/test/key-trust.test.tree run by the CLI of this checkout, on node, in deck/deck.
// Its three refusals that reach the signature are the only check anywhere that fails when key-trust.tree's signed-by
// skips verify-id (trap T-1532 of term/self-host change 001): every other refusal in deck/deck's tests is met by a
// sequence, shape or membership check first. deck/deck's own Term suite is not a term:test suite, so this one file of
// it is. Run: npx tsx test/deck/key-trust.ts

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { TERM_ROOT } from '../../task/term/root'

const line = process.env.TERM_LINE ?? join(TERM_ROOT, 'host/line.js')
const run = spawnSync(
  process.execPath,
  [line, 'test', 'test/key-trust.test.tree', '--env', 'node', '--color', 'never', '--no-motion'],
  { cwd: join(TERM_ROOT, 'deck/deck'), encoding: 'utf8', timeout: 600_000 },
)
const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`

process.stdout.write(output)

// the runner's last count line: `<time> · <s> · 13 tests · 13 passed` and `· 3 failed` when some did
const counts = output
  .split('\n')
  .map(line => /(\d+) tests? · (\d+) passed(?: · (\d+) failed)?/.exec(line))
  .filter(found => found !== null)
  .at(-1)
const passed = Number(counts?.[2] ?? 0)
const failed = Number(counts?.[3] ?? (run.status === 0 ? 0 : 1))

console.log(`\ndeck/key-trust: ${passed} pass, ${failed} fail`)
process.exit(run.status === 0 && failed === 0 && passed > 0 ? 0 : 1)
