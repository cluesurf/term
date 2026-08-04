// Unit tests for @cluesurf/scan: version comparison and range satisfaction, advisory matching + upgrade planning,
// OSV import, the static rules (native-danger + taint), SARIF shape, and the manifest fixer. Pure, no filesystem.
// Run: npx tsx test/scan/unit.ts

import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import {
  toMark,
  compareVersion,
  satisfies,
} from '@term/scan/code/semver'
import { isAffected, planUpgrade } from '@term/scan/code/match'
import { fromOsv, fromOsvFeed } from '@term/scan/code/osv'
import type { OsvRecord } from '@term/scan/code/osv'
import type { Advisory, CodeFinding, ScanResult } from '@term/scan/code/form'
import { runRules } from '@term/scan/code/rule'
import { nativeDangerRule } from '@term/scan/code/rule/native-danger'
import { taintRule } from '@term/scan/code/rule/taint'
import { toSarif } from '@term/scan/code/sarif'
import { applyUpgradesToManifest, planUpgrades } from '@term/scan/code/fix'

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

function milled(text: string): CodeFinding[] {
  const parsed = parse({ file: 't.tree', text })

  if (!parsed.ok) {
    throw new Error('parse failed')
  }

  const m = mill(parsed.tree, 't.tree')

  if (!m.ok) {
    throw new Error('mill failed')
  }

  return runRules(m.program, 't.tree', [nativeDangerRule, taintRule])
}

// ---- semver ----
ok(toMark('1.2.3')?.patch === 3, 'toMark parses a full version')
ok(toMark('v1.2')?.minor === 2, 'toMark strips v and pads missing patch')
ok(toMark('nope') === undefined, 'toMark rejects non-versions')
ok(compareVersion('1.2.0', '1.10.0') < 0, 'compareVersion is numeric not lexical')
ok(compareVersion('2.0.0', '2.0.0') === 0, 'compareVersion equal')
ok(satisfies('1.2.3', '>=1.0.0 <2.0.0'), 'satisfies AND range')
ok(!satisfies('2.0.0', '>=1.0.0 <2.0.0'), 'satisfies excludes upper bound')
ok(satisfies('1.5.0', '<1.2.0 || >=1.4.0'), 'satisfies OR range')
ok(satisfies('1.2.3', '1.0.0 - 1.3.0'), 'satisfies hyphen range')
ok(satisfies('1.9.9', '^1.2.0'), 'satisfies caret range')
ok(!satisfies('2.0.0', '^1.2.0'), 'caret excludes next major')
ok(satisfies('3.1.4', '*'), 'satisfies wildcard any')

// ---- match ----
const adv: Advisory = {
  id: 'GHSA-test',
  packageName: 'left-pad.tree',
  severity: 'high',
  title: 'test',
  url: 'https://example.com',
  ranges: [{ introduced: '1.0.0', fixed: '1.3.0' }],
  fixedVersions: ['1.3.0'],
}
ok(isAffected('1.2.0', adv), 'isAffected inside range')
ok(!isAffected('1.3.0', adv), 'isAffected excludes fixed version')
ok(!isAffected('0.9.0', adv), 'isAffected excludes below introduced')
ok(
  isAffected('1.4.4', {
    ...adv,
    ranges: [],
    versions: ['1.4.4'],
  }),
  'isAffected matches an explicit version',
)
ok(
  isAffected('1.1.0', {
    ...adv,
    ranges: [],
    rangeExpression: '<1.2.0',
  }),
  'isAffected matches an npm range expression',
)
ok(
  planUpgrade('1.1.0', [adv]) === '1.3.0',
  'planUpgrade picks the fixed version',
)
ok(
  planUpgrade('1.1.0', [
    adv,
    { ...adv, id: 'GHSA-2', ranges: [{ introduced: '1.0.0', fixed: '1.5.0' }], fixedVersions: ['1.5.0'] },
  ]) === '1.5.0',
  'planUpgrade clears every advisory (takes the higher fix)',
)

// ---- OSV import ----
const osv: OsvRecord = {
  id: 'GHSA-abcd',
  summary: 'Prototype pollution',
  affected: [
    {
      package: { ecosystem: 'npm', name: 'lodash' },
      ranges: [
        {
          type: 'SEMVER',
          events: [{ introduced: '0' }, { fixed: '4.17.21' }],
        },
      ],
    },
  ],
  references: [{ type: 'ADVISORY', url: 'https://github.com/advisories/GHSA-abcd' }],
  database_specific: { severity: 'HIGH' },
}
const imported = fromOsv(osv, 'npm')
ok(imported?.packageName === 'lodash.tree', 'OSV maps package to registry name')
ok(imported?.severity === 'high', 'OSV maps textual severity')
ok(imported?.ranges[0]?.fixed === '4.17.21', 'OSV reads the fixed event')
ok(isAffected('4.17.20', imported!), 'OSV-imported advisory matches an affected version')
ok(!isAffected('4.17.21', imported!), 'OSV-imported advisory excludes the fix')
ok(
  fromOsvFeed([osv], 'npm').length === 1 && fromOsvFeed([osv], 'term').length === 0,
  'OSV feed filters by ecosystem',
)

// ---- rules: native-danger ----
const dangerFindings = milled(`dock load
  load <node:child_process>, name cp

task run-it
  take command, like text
  like text
  send back
    call cp/exec
      read command
`)
ok(
  dangerFindings.some(f => f.ruleId === 'scan/native-danger'),
  'native-danger flags child_process import',
)
ok(
  dangerFindings.some(
    f => f.ruleId === 'scan/taint' && /command . code injection/.test(f.message),
  ),
  'taint flags param -> cp/exec',
)

// ---- rules: taint is silenced by a sanitizer ----
const sanitized = milled(`dock load
  load <node:child_process>, name cp

task run-it
  take command, like text
  like text
  save safe
    call shell-escape
      read command
  send back
    call cp/exec
      read safe
`)
ok(
  !sanitized.some(f => f.ruleId === 'scan/taint'),
  'taint is cleared when input passes through a sanitizer',
)

// ---- rules: no taint when the sink argument is a constant ----
const constant = milled(`dock load
  load <node:child_process>, name cp

task run-it
  take command, like text
  like text
  send back
    call cp/exec
      text <ls -la>
`)
ok(
  !constant.some(f => f.ruleId === 'scan/taint'),
  'taint does not fire on a constant sink argument',
)

// ---- SARIF ----
const result: ScanResult = {
  findings: [
    {
      kind: 'dependency',
      advisory: adv,
      node: {
        name: 'left-pad',
        registryName: 'left-pad.tree',
        version: '1.1.0',
        direct: true,
        path: ['left-pad'],
      },
      severity: 'high',
      fixVersion: '1.3.0',
    },
    {
      kind: 'code',
      ruleId: 'scan/taint',
      severity: 'high',
      message: 'tainted',
      at: { file: '/repo/deck/x/code/a.tree', line: 5, column: 3 },
      trace: [
        { file: '/repo/deck/x/code/a.tree', line: 3, column: 8, label: 'tainted input' },
        { file: '/repo/deck/x/code/a.tree', line: 5, column: 3, label: 'sink' },
      ],
    },
  ],
  dependencyCount: 1,
  fileCount: 1,
  bySeverity: { critical: 0, high: 2, moderate: 0, low: 0, info: 0 },
  advisorySources: ['local:/repo/advisory'],
  unavailableSources: [],
}
const sarif = toSarif(result, { root: '/repo' }) as {
  runs: { results: { ruleId: string; level: string; locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[]; codeFlows?: unknown[] }[] }[]
}
const run = sarif.runs[0]!
ok(run.results.length === 2, 'SARIF emits one result per finding')
ok(
  run.results[0]!.locations[0]!.physicalLocation.artifactLocation.uri === 'deck.tree',
  'SARIF anchors a dependency finding at the manifest, relative to root',
)
ok(
  run.results[1]!.locations[0]!.physicalLocation.artifactLocation.uri === 'deck/x/code/a.tree',
  'SARIF makes code-finding paths repo-relative',
)
ok(
  run.results[1]!.locations[0]!.physicalLocation.region.startLine === 5,
  'SARIF keeps the code finding line',
)
ok(Array.isArray(run.results[1]!.codeFlows), 'SARIF renders the taint trace as a code flow')

// ---- fix ----
const upgrades = planUpgrades([
  result.findings[0] as Extract<(typeof result.findings)[number], { kind: 'dependency' }>,
])
ok(upgrades.length === 1 && upgrades[0]!.to === '1.3.0', 'planUpgrades collapses to one upgrade per package')
const manifest = `deck app\n  mark <1.0.0>\n\n  link @term/left-pad, mark <^1.1.0>\n  link @term/other, mark <^2.0.0>\n`
const patched = applyUpgradesToManifest(manifest, [
  { name: '@term/left-pad', from: '1.1.0', to: '1.3.0', clears: ['GHSA-test'] },
])
ok(patched.includes('link @term/left-pad, mark <^1.3.0>'), 'fixer rewrites the vulnerable dependency line')
ok(patched.includes('link @term/other, mark <^2.0.0>'), 'fixer leaves other lines untouched')

console.log(`\nscan/unit: ${pass} pass, ${fail} fail`)

if (fail) {
  process.exit(1)
}
