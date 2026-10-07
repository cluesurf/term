// A Kotlin program prints nothing a node, rust or swift build does not (item term-self-host-001-0220). The process
// runner spawns through java.lang.foreign, and JDK 24 and newer print a restricted-method warning on stderr unless
// native access is granted. native-build.ts grants it twice: `--enable-native-access=ALL-UNNAMED` on the command it
// answers, and `Enable-Native-Access: ALL-UNNAMED` in the jar's manifest, so a jar handed out and run with a plain
// `java -jar` is quiet too.
//
// Cases, on a Kotlin program that calls process/run:
//   command    the command buildNative answers prints the run's answer and nothing on stderr
//   plain      `java -jar <jar>` with no flag prints the same and nothing on stderr (the manifest attribute)
//   manifest   the jar's manifest holds the attribute
//   control    the same classes run with no manifest read and no flag (`java -cp`) DO warn on JDK 24 and newer, so a
//              silent run above is the grant at work and not a program that never reaches the runner
// Run: sh /Users/lancepollard/base/crew/cluesurf/tmp/run-term.sh npx tsx test/compile/kotlin-native-access.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { buildNative } from '@term/call/code/native-build'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitKotlin } from '@term/make/code/compile/kotlin'

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

const PROGRAM = String.raw`load @term/base/process/run
  find run, name run-command

load @term/base/list
  find list

task run
  mark async
  like text
  save empty, make list
  save probe, run-command(<true>, empty)
  back <ran {probe/code}>
`

const have = (tool: string): boolean => spawnSync('which', [tool], { encoding: 'utf8' }).status === 0

if (!['kotlinc', 'java', 'jar'].every(have)) {
  console.log('skip  kotlin-native-access: kotlinc, java or jar not installed')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'term-kotlin-native-access-'))
const file = join(dir, 'access.tree')
const resolve = projectResolver(process.cwd(), 'kotlin')
const result = compile({ file, text: PROGRAM }, { resolve, env: 'kotlin' })

ok('the program compiles for Kotlin', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))

if (!result.ok) {
  process.exit(1)
}

const kotlin = emitKotlin(result.program)
const source = `${nativePrelude(result.program, 'kotlin', file => (existsSync(file) ? readFileSync(file, 'utf8') : undefined), kotlin)}\n${kotlin}`
const built = buildNative({ source, target: 'kotlin', folder: dir, name: 'access' })

ok('the program builds', built.ok, built.ok ? '' : built.reason)

if (!built.ok) {
  process.exit(1)
}

const read = (command: string[]): { out: string; err: string; status: number | null } => {
  const ran = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8' })

  return { out: String(ran.stdout), err: String(ran.stderr), status: ran.status }
}

const viaCommand = read(built.command)
ok('command: prints the answer and nothing on stderr', viaCommand.out === 'ran 0' && viaCommand.err === '', JSON.stringify(viaCommand))

const plain = read(['java', '-jar', built.artifact])
ok('plain java -jar: prints the answer and nothing on stderr', plain.out === 'ran 0' && plain.err === '', JSON.stringify(plain))

const listed = read(['jar', '--describe-module', '--file', built.artifact])
const manifest = spawnSync('unzip', ['-p', built.artifact, 'META-INF/MANIFEST.MF'], { encoding: 'utf8' })
ok('manifest: holds Enable-Native-Access', /Enable-Native-Access: ALL-UNNAMED/.test(String(manifest.stdout)), `${listed.err}${manifest.stdout}`)

const version = Number(/version "(\d+)/.exec(read(['java', '-version']).err)?.[1] ?? '0')
const control = read(['java', '-cp', built.artifact, 'AccessKt'])

if (version >= 24) {
  ok(`control: without the grant JDK ${version} warns`, /restricted method|native access/i.test(control.err), JSON.stringify(control))
} else {
  console.log(`skip  control: JDK ${version} prints no restricted-method warning`)
}

console.log(`\nkotlin-native-access: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
