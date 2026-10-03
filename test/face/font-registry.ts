// The font contract against the web's (native-text-0001). deck/face/code/font/font.tree resolves which face a run is
// set in; mesh/deck/face/code/tool/font/resolve.ts is the resolver word.surf runs today. Both read belt's tables (the
// Term side through table.tree, which `pnpm term:font-table` writes from them), so the two must agree on every input
// the web can be given: every script belt sets, every alias, every family named outright, and the misses.
//
// The web resolver takes the script's own key, so an ALIAS is held to what belt's `scriptFontName` answers for it (the
// same lookup after `knownScript`), resolved through the web's font table. A miss on both sides is the house face.
//
// On every target the contract runs on: the same probe program on TypeScript, on Swift (swiftc, run on this Mac) and on
// Kotlin (kotlinc, run on the JVM), each answer held to the web's. A missing toolchain skips its leg and says so.
//
// Run: npx tsx test/face/font-registry.ts   (FONT_DIR=<dir> reads the three files from elsewhere, FONT_LEGS=swift one)

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { projectResolver } from '@term/call/code/make'
import FONT from '../../../../../../mesh/deck/belt/code/base/font'
import SCRIPT, { SCRIPT_ALIAS, scriptFontName } from '../../../../../../mesh/deck/belt/code/base/script'
import { resolveFontForScript } from '../../../../../../mesh/deck/face/code/tool/font/resolve'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const ROOT = process.cwd()
const FONT_DIR = resolve(process.env.FONT_DIR || join(ROOT, 'deck/face/code/font'))
const HOUSE = 'CrowMark'

// every input, with what the web answers for it
type Probe = { family: string; script: string; web: string }

const probes: Probe[] = []
const web = ({ family, script }: { family?: string; script?: string }): string =>
  resolveFontForScript({ font: family, script, scriptConfig: SCRIPT, fontConfig: FONT })?.family ?? HOUSE

for (const script of Object.keys(SCRIPT)) {
  probes.push({ family: '', script, web: web({ script }) })
}

for (const alias of Object.keys(SCRIPT_ALIAS)) {
  const family = scriptFontName(alias)
  probes.push({ family: '', script: alias, web: (family && FONT[family]?.family) || HOUSE })
}

for (const family of Object.keys(FONT)) {
  probes.push({ family, script: '', web: web({ family }) })
}

// a family named outright wins over the script, and the misses fall through in order
probes.push({ family: 'Noto Sans Mono', script: 'tibetan', web: web({ family: 'Noto Sans Mono', script: 'tibetan' }) })
probes.push({ family: 'No Such Face', script: 'tibetan', web: web({ family: 'No Such Face', script: 'tibetan' }) })
probes.push({ family: 'No Such Face', script: 'no-such-script', web: web({ family: 'No Such Face', script: 'no-such-script' }) })
probes.push({ family: '', script: '', web: web({}) })

// the program: an entry that resolves every probe, beside the contract's three files. A relative load may not leave
// its package (projectResolver confines it), and the temporary directory is in no package, so the three are handed to
// the compiler by name and everything else resolves as in a build
const dir = mkdtempSync(join(tmpdir(), 'term-font-registry-'))
const CONTRACT = ['font', 'record', 'table']
const contract = new Map(CONTRACT.map(name => [`./${name}`, { file: join(FONT_DIR, `${name}.tree`), text: readFileSync(join(FONT_DIR, `${name}.tree`), 'utf8') }]))
const base = projectResolver(ROOT, 'node')
const resolveImport = (importPath: string, fromFile: string) => contract.get(importPath) ?? base(importPath, fromFile)

const quote = (value: string) => `text <${value}>`
const calls = probes
  .map(
    (probe, i) => `  save picked-${i}
    call resolve-font
      bind family, ${quote(probe.family)}
      bind script, ${quote(probe.script)}
  call push
    bind list, read out
    bind item, read picked-${i}/family`,
  )
  .join('\n')

const PROGRAM = `load ./font
  find resolve-font
  find resolve-weight
load ./record
  find font
load @term/base/code/list
  find list
  find push
load @term/base/code/text/util
  find join

# every probe's family, in order, as one line every backend can print
task report
  like text
  send back
    call join
      call run
      text <|>

task run
  like list
    like text
  save out
    make list
${calls}
  send back, read out

task run-weights
  like list
    like number
  save out
    make list
  call push
    bind list, read out
    bind item
      call resolve-weight
        text <anatolian>
  call push
    bind list, read out
    bind item
      call resolve-weight
        text <anatolian-hieroglyphs>
  call push
    bind list, read out
    bind item
      call resolve-weight
        text <latin>
  send back, read out
`

const entry = join(dir, 'probe.tree')
writeFileSync(entry, PROGRAM)

const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
const have = (command: string): boolean => spawnSync('which', [command]).status === 0
const scripts = Object.keys(SCRIPT).length
const aliases = Object.keys(SCRIPT_ALIAS).length
const fonts = Object.keys(FONT).length

// one target's answer, held to the web's: every probe, then the three orderings by name
function judge(leg: string, report: string): void {
  const families = report.split('|')
  const wrong = probes.filter((probe, i) => families[i] !== probe.web)

  ok(
    `${leg}: every probe resolves to the web's face, ${probes.length - wrong.length} of ${probes.length} (${scripts} scripts, ${aliases} aliases, ${fonts} families, 4 orderings)`,
    families.length === probes.length && wrong.length === 0,
    `${families.length} answers | ${wrong
      .slice(0, 6)
      .map(probe => `${probe.family || '-'} / ${probe.script || '-'}: term ${families[probes.indexOf(probe)]}, web ${probe.web}`)
      .join(' | ')}`,
  )
  ok(`${leg}: a family named outright wins over the script`, families[probes.length - 4] === 'Noto Sans Mono', families[probes.length - 4])
  ok(`${leg}: an unknown family falls to the script`, families[probes.length - 3] === web({ script: 'tibetan' }), families[probes.length - 3])
  ok(`${leg}: nothing known falls to the house face`, families[probes.length - 2] === HOUSE && families[probes.length - 1] === HOUSE)
}

// the front end for one target, with the diagnostics a failure states
function frontEnd(env: 'node' | 'swift' | 'kotlin') {
  const result = compile({ file: entry, text: PROGRAM }, { resolve: resolveImport, env })
  ok(
    `${env === 'node' ? 'typescript' : env}: the contract and its table compile`,
    result.ok,
    result.ok ? '' : [...new Set(result.diagnostics.map(d => `${d.file ?? ''}: ${d.message}`))].slice(0, 8).join(' | '),
  )

  return result.ok ? result : undefined
}

// a native toolchain's failure, as its own error lines rather than the whole log
const failure = (error: unknown): string => {
  const text = String((error as { stderr?: Buffer }).stderr ?? error)

  return text.split('\n').filter(line => /error:|e: /.test(line)).join('\n').slice(0, 1600) || text.slice(0, 800)
}

function runTypescript(): void {
  const result = frontEnd('node')

  if (!result) {
    return
  }

  const prelude = nativePrelude(result.program, 'node', readRuntime, result.typescript)
  const file = join(dir, 'probe.ts')
  writeFileSync(file, `${prelude}\n${result.typescript}\nconsole.log(JSON.stringify({ report: report(), weights: runWeights() }))\n`)
  const ran = spawnSync('npx', ['tsx', file], { encoding: 'utf8', maxBuffer: 1 << 26 })
  ok('typescript: it runs', ran.status === 0, ran.stderr.slice(0, 600))

  if (ran.status !== 0) {
    return
  }

  const { report: said, weights } = JSON.parse(ran.stdout.trim().split('\n').pop()!) as { report: string; weights: number[] }
  judge('typescript', said)
  ok(
    'typescript: a decided weight is read, under an alias too, and an undecided one is 0',
    weights[0] === SCRIPT.anatolian.weight && weights[1] === SCRIPT.anatolian.weight && weights[2] === 0,
    JSON.stringify(weights),
  )
}

function runSwift(): void {
  if (!have('swiftc')) {
    console.log('skip  swift: swiftc not installed')

    return
  }

  const result = frontEnd('swift')

  if (!result) {
    return
  }

  const swift = emitSwift(result.program)
  const call = /func report\(\)[^{]*throws/.test(swift) ? 'try! report()' : 'report()'
  const file = join(dir, 'probe.swift')
  writeFileSync(file, ['import Foundation', nativePrelude(result.program, 'swift', readRuntime, swift), swift, `print(${call})`, ''].join('\n'))

  try {
    execFileSync('swiftc', ['-o', join(dir, 'probe-swift'), file], { stdio: 'pipe' })
  } catch (error) {
    ok('swift: builds', false, failure(error))

    return
  }

  ok('swift: builds', true)
  judge('swift', execFileSync(join(dir, 'probe-swift'), { maxBuffer: 1 << 26 }).toString().trim())
}

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    console.log('skip  kotlin: kotlinc or java not installed')

    return
  }

  const result = frontEnd('kotlin')

  if (!result) {
    return
  }

  const kotlin = emitKotlin(result.program)
  const file = join(dir, 'probe.kt')
  writeFileSync(file, hoistKotlinImports(`${nativePrelude(result.program, 'kotlin', readRuntime, kotlin)}\n${kotlin}\nfun main() { print(report()) }\n`))
  const jar = join(dir, 'probe.jar')

  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: 'pipe' })
  } catch (error) {
    ok('kotlin: builds', false, failure(error))

    return
  }

  ok('kotlin: builds', true)
  judge('kotlin', execFileSync('java', ['-jar', jar], { maxBuffer: 1 << 26 }).toString().trim())
}

// FONT_LEGS=typescript,swift,kotlin picks the targets (all three by default)
const legs = (process.env.FONT_LEGS || 'typescript,swift,kotlin').split(',')

if (legs.includes('typescript')) {
  // face's table is belt's table as of now: the generator in report mode exits 1 on drift. Only for face's own copy,
  // since a FONT_DIR elsewhere is a scratch copy the generator does not write
  if (!process.env.FONT_DIR) {
    const drift = spawnSync('npx', ['tsx', join(ROOT, '../../../../task/term/font-table.ts')], { encoding: 'utf8' })
    ok('the table is belt\'s table (pnpm term:font-table reports it in step)', drift.status === 0, drift.stdout.trim().split('\n').pop() ?? '')
  }

  runTypescript()
}

if (legs.includes('swift')) {
  runSwift()
}

if (legs.includes('kotlin')) {
  runKotlin()
}

console.log(`\nfont-registry: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
