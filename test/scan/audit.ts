// Integration test for @cluesurf/scan: a real temp project with a manifest, a lockfile, a local advisory database,
// and a vulnerable code file. Runs the full scan end to end and the manifest fixer. Run: npx tsx test/scan/audit.ts

import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { runScan } from '@term/scan/code/scan'
import { localDatabaseSource } from '@term/scan/code/advisory'
import { planUpgrades, applyUpgrades } from '@term/scan/code/fix'
import type { DependencyFinding } from '@term/scan/code/form'

let pass = 0
let fail = 0

function ok(cond: boolean, name: string, detail = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

const MANIFEST = `deck @term/app
  mark <1.0.0>

  link @term/left-pad, mark <^1.1.0>
`

// left-pad@1.1.0 is pinned; it depends on inner@1.0.0 (transitive)
const LOCKFILE = `lock <1>

deck @term/left-pad
  mark <1.1.0>
  hash <aaaa>
  site <https://deck.term.surf/@term/left-pad>
  link @term/inner, mark <1.0.0>

deck @term/inner
  mark <1.0.0>
  hash <bbbb>
  site <https://deck.term.surf/@term/inner>
`

// an OSV advisory affecting left-pad < 1.3.0, in the term ecosystem
const ADVISORY = JSON.stringify([
  {
    id: 'GHSA-app-0001',
    summary: 'left-pad denial of service on long input',
    affected: [
      {
        package: { ecosystem: 'term', name: '@term/left-pad' },
        ranges: [
          { type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.3.0' }] },
        ],
      },
    ],
    references: [{ type: 'ADVISORY', url: 'https://term.surf/advisory/GHSA-app-0001' }],
    database_specific: { severity: 'MODERATE' },
  },
])

// a vulnerable code file: a task parameter flows into cp/exec unsanitized
const DANGER = `dock load
  load <node:child_process>, name cp

task run-shell
  take user-input, like text
  like text
  send back
    call cp/exec
      read user-input
`

async function main(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'scan-audit-'))

  await fsp.writeFile(path.join(root, 'deck.tree'), MANIFEST)
  await fsp.writeFile(path.join(root, 'lock.tree'), LOCKFILE)
  await fsp.mkdir(path.join(root, 'advisory'), { recursive: true })
  await fsp.writeFile(path.join(root, 'advisory', 'ghsa.json'), ADVISORY)
  await fsp.mkdir(path.join(root, 'deck', 'x', 'code'), { recursive: true })
  await fsp.writeFile(
    path.join(root, 'deck', 'x', 'code', 'danger.tree'),
    DANGER,
  )

  // scan with ONLY the local advisory source (no network), plus the code scan
  const result = await runScan({
    root,
    deps: true,
    code: true,
    sources: [localDatabaseSource(path.join(root, 'advisory'), 'term')],
  })

  ok(result.dependencyCount === 2, 'reads both locked dependencies', `got ${result.dependencyCount}`)

  const depFindings = result.findings.filter(
    (f): f is DependencyFinding => f.kind === 'dependency',
  )
  ok(depFindings.length === 1, 'finds the one vulnerable dependency', `got ${depFindings.length}`)

  const leftPad = depFindings[0]
  ok(leftPad?.node.name === '@term/left-pad', 'names the vulnerable package')
  ok(leftPad?.node.version === '1.1.0', 'reports the installed version')
  ok(leftPad?.node.direct === true, 'marks it a direct dependency')
  ok(leftPad?.severity === 'moderate', 'carries the advisory severity')
  ok(leftPad?.fixVersion === '1.3.0', 'computes the safe upgrade', `got ${leftPad?.fixVersion}`)

  const codeFindings = result.findings.filter(f => f.kind === 'code')
  ok(
    codeFindings.some(f => f.ruleId === 'scan/native-danger'),
    'flags the child_process import',
  )
  ok(
    codeFindings.some(f => f.ruleId === 'scan/taint'),
    'flags the param -> cp/exec taint',
  )

  ok(
    result.advisorySources.length === 1 && result.unavailableSources.length === 0,
    'records the consulted source and no unavailable ones',
  )

  // the fixer rewrites the manifest to the safe version
  const upgrades = planUpgrades(depFindings)
  const applied = await applyUpgrades({ root, upgrades, write: true })
  ok(applied.applied.length === 1, 'applies one upgrade')

  const rewritten = await fsp.readFile(path.join(root, 'deck.tree'), 'utf-8')
  ok(
    rewritten.includes('link @term/left-pad, mark <^1.3.0>'),
    'manifest now pins the safe version',
    rewritten,
  )

  // after the fix, re-running finds no dependency vulnerability (the lockfile still pins 1.1.0, so we simulate the
  // post-install state by bumping the lock too and re-scanning)
  const fixedLock = LOCKFILE.replace('mark <1.1.0>', 'mark <1.3.0>')
  await fsp.writeFile(path.join(root, 'lock.tree'), fixedLock)
  const after = await runScan({
    root,
    deps: true,
    code: false,
    sources: [localDatabaseSource(path.join(root, 'advisory'), 'term')],
  })
  ok(
    after.findings.filter(f => f.kind === 'dependency').length === 0,
    'no dependency findings after upgrading to the fixed version',
  )

  await fsp.rm(root, { recursive: true, force: true })

  console.log(`\nscan/audit: ${pass} pass, ${fail} fail`)

  if (fail) {
    process.exit(1)
  }
}

main()
