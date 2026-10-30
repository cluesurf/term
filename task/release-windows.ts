// The Windows step of `pnpm term:release` (D8, decided 2026-10-02: windows-x64 is built natively on an on-demand EC2
// Windows machine and smoke-run in the same session). release.ts stages windows-x64 as it stages every platform, all
// but its native part, and runs this under `zone load cluesurf/bench` for the EC2 key. This:
//
//   1  rents a machine (task/term/cask/ec2-windows.ts) with Node, Go, the MSVC build tools and Rust, ending itself
//      after --hours whatever happens here
//   2  says the toolchain's versions, and builds and runs a one-file Rust crate there: MSVC links on this machine
//   3  BUILDS THE PAYLOAD'S NATIVE PART THERE: bin\term.exe (task/launcher/term.go) by Windows' own Go, brought back
//      into the stage. The same source cross-built on this Mac is compared with it, digest for digest
//   4  packs the stage here (task/release-pack.ts, as every platform is packed), and ships the tarball back
//   5  SMOKE-RUNS THE TARBALL THERE: its sha256 read on the machine, unpacked by Windows' tar.exe into a fresh folder
//      under a fresh profile, `term.exe --version`, `term.cmd --version`, and `term make` on a one-file project
//   6  destroys the machine, in a `finally`, after a failure or a signal too
//
// The payload is still the Node build (task/release.ts, "THE PAYLOAD IS THE NODE BUILD"), so term.exe is its one
// native part today. When the native term lands (self-host item 0161) its cargo build joins step 3, on the toolchain
// step 2 proves.
//
// It speaks to release.ts in JSON lines on stdout, as the push child does: { form: 'tools' | 'native' | 'smoke' |
// 'built' | 'failed', ... }. Every other line (the machine's own progress) is a note.
//
//   zone load cluesurf/bench -- pnpm -s exec tsx task/release-windows.ts --stage <dir> --out <tar.gz> [--hours 2]
//     [--fail-at tools|native|packed|smoke]   throw at that step, to prove the machine still ends (never in a release)

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as ec2Module from '../../../../../task/term/cask/ec2-windows'
import { packPayload } from './release-pack'

// task/term/cask is CommonJS, whose exports Node hands an ES module on `default`
const ec2 = ((ec2Module as { default?: typeof ec2Module }).default ?? ec2Module) as typeof ec2Module

const TERM = path.resolve(import.meta.dirname, '..')
const LAUNCHER = path.join(TERM, 'task', 'launcher')
// where the step keeps what it sends, under the profile of the machine's Administrator
const REMOTE = 'term-release'

type Said =
  | { form: 'tools'; text: string; crate: string }
  | { form: 'native'; file: string; digest: string; cross: string; same: boolean }
  | { form: 'smoke'; digest: string; version: string; made: string }
  | { form: 'built'; platform: 'windows-x64'; file: string; digest: string; bytes: number; minutes: number; dollars: number; instance: string }
  | { form: 'failed'; message: string }

const say = (said: Said): void => {
  process.stdout.write(`${JSON.stringify(said)}\n`)
}

const argv = process.argv.slice(2)
const valueOf = (flag: string): string | undefined => {
  const at = argv.indexOf(flag)

  return at === -1 ? undefined : argv[at + 1]
}

const digestOf = (file: string): string => `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`

// the forced failure, for the proof that the machine ends whatever the step does
function failAt(step: string): void {
  if (valueOf('--fail-at') === step) {
    throw new Error(`--fail-at ${step}: a failure forced at this step`)
  }
}

async function main(): Promise<void> {
  const stage = valueOf('--stage')
  const out = valueOf('--out')
  const hours = Number(valueOf('--hours') ?? 2)

  if (!stage || !out || !existsSync(path.join(stage, 'term', 'bin', 'term.cmd'))) {
    throw new Error('--stage <dir> holding a staged term/ (bin\\term.cmd in it) and --out <tar.gz> are needed')
  }

  // what is sent, beside the stage and never inside it: the launcher's source, a one-file crate, and later the tarball
  // with a project to build
  const sent = path.join(path.dirname(stage), 'windows-sent')
  rmSync(sent, { recursive: true, force: true })
  mkdirSync(path.join(sent, 'launcher'), { recursive: true })
  copyFileSync(path.join(LAUNCHER, 'term.go'), path.join(sent, 'launcher', 'term.go'))
  mkdirSync(path.join(sent, 'crate', 'src'), { recursive: true })
  writeFileSync(path.join(sent, 'crate', 'Cargo.toml'), '[package]\nname = "term-release-crate"\nversion = "0.0.0"\nedition = "2021"\n')
  writeFileSync(path.join(sent, 'crate', 'src', 'main.rs'), 'fn main() {\n    println!("crate linked for {}", std::env::consts::ARCH);\n}\n')

  // the same source cross-built here, for the comparison: reproducible Go builds are the same bytes on any host
  const cross = path.join(path.dirname(stage), 'term-cross.exe')
  execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', cross, path.join(LAUNCHER, 'term.go')], {
    env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  const { answer, minutes } = await ec2.session({
    needs: ['node', 'go', 'build'],
    hours,
    work: async (machine, stopped) => {
      const halt = (): void => {
        if (stopped()) throw new Error('stopped')
      }

      // 2  the toolchain, and MSVC linking a crate
      ec2.shipIn(machine, sent, REMOTE)
      const tools = ec2.run(machine, 'node --version & go version & rustc --version & cargo --version', { timeout: 120_000 })
      const crate = ec2.run(machine, `cd /d %USERPROFILE%\\${REMOTE}\\crate && cargo build --release --quiet && target\\release\\term-release-crate.exe`, { timeout: 900_000 })

      if (crate.status !== 0 || !crate.stdout.includes('crate linked for x86_64')) {
        throw new Error(`the Rust crate did not build and run with MSVC there:\n${tools.stdout}${crate.stdout}${crate.stderr}`)
      }

      say({ form: 'tools', text: tools.stdout.trim(), crate: crate.stdout.trim() })
      failAt('tools')
      halt()

      // 3  the native part, by Windows' own Go
      const built = ec2.run(machine, `cd /d %USERPROFILE%\\${REMOTE}\\launcher && set CGO_ENABLED=0&& set GOOS=windows&& set GOARCH=amd64&& go build -trimpath -ldflags "-s -w" -o term.exe term.go`, { timeout: 600_000 })
      const exe = path.join(stage, 'term', 'bin', 'term.exe')
      rmSync(exe, { force: true })

      if (built.status !== 0 || !ec2.shipOut(machine, `${REMOTE}/launcher/term.exe`, exe)) {
        throw new Error(`term.exe was not built there:\n${built.stdout}${built.stderr}`)
      }

      const native = digestOf(exe)
      const crossDigest = digestOf(cross)
      say({ form: 'native', file: 'bin/term.exe', digest: native, cross: crossDigest, same: native === crossDigest })
      failAt('native')
      halt()

      // 4  packed here, as every platform is
      const packed = packPayload({ stage, file: out })
      failAt('packed')

      // 5  the tarball there, read back, unpacked fresh and run
      const smoke = path.join(path.dirname(stage), 'windows-smoke')
      rmSync(smoke, { recursive: true, force: true })
      mkdirSync(path.join(smoke, 'sample', 'code'), { recursive: true })
      copyFileSync(out, path.join(smoke, 'term-windows-x64.tar.gz'))
      writeFileSync(path.join(smoke, 'sample', 'deck.tree'), 'deck @sample/hello\nhead <A sample project the release smoke-runs on Windows>\nmark <0.0.0>\n')
      writeFileSync(path.join(smoke, 'sample', 'code', 'base.tree'), 'task greet\n  take name, like text\n  like text\n  send back, text <hello {name}>\n')
      ec2.shipIn(machine, smoke, `${REMOTE}\\smoke`)
      halt()

      const ran = ec2.runPowerShell(machine, [
        `$root = "$env:USERPROFILE\\${REMOTE}"`,
        '$hash = (Get-FileHash "$root\\smoke\\term-windows-x64.tar.gz" -Algorithm SHA256).Hash.ToLower()',
        'Write-Output "digest sha256:$hash"',
        'New-Item -ItemType Directory -Force -Path "$root\\run", "$root\\home" | Out-Null',
        '& "$env:SystemRoot\\System32\\tar.exe" -xzf "$root\\smoke\\term-windows-x64.tar.gz" -C "$root\\run"',
        'if ($LASTEXITCODE -ne 0) { Write-Output "unpack failed $LASTEXITCODE"; exit 1 }',
        // a fresh machine as far as term can tell: its own profile, and no install on first use
        '$env:USERPROFILE = "$root\\home"',
        "$env:TERM_NEED = 'local'",
        '$exe = & "$root\\run\\term\\bin\\term.exe" --version 2>&1 | Out-String',
        '$exeCode = $LASTEXITCODE',
        '$cmd = & "$root\\run\\term\\bin\\term.cmd" --version 2>&1 | Out-String',
        '$cmdCode = $LASTEXITCODE',
        'Set-Location "$root\\smoke\\sample"',
        '$made = & "$root\\run\\term\\bin\\term.cmd" make --plain --color never 2>&1 | Out-String',
        '$madeCode = $LASTEXITCODE',
        '$hosted = (Get-ChildItem -Recurse -Name host) -join " "',
        'Write-Output "exe $exeCode $($exe.Trim())"',
        'Write-Output "cmd $cmdCode $($cmd.Trim())"',
        'Write-Output "make $madeCode $($made.Trim())"',
        'Write-Output "host $hosted"',
        'if ($exeCode -ne 0 -or $cmdCode -ne 0 -or $madeCode -ne 0) { exit 1 }',
        'exit 0',
      ].join('\n'), { timeout: 900_000 })
      const text = `${ran.stdout}${ran.stderr}`
      const there = /digest (sha256:[0-9a-f]{64})/.exec(text)?.[1] ?? ''
      const version = /^exe 0 (.*)$/m.exec(text)?.[1]?.trim() ?? ''
      const made = /^make 0 ([\s\S]*?)^host /m.exec(text)?.[1]?.trim() ?? ''

      if (ran.status !== 0 || there !== packed.digest || !version || !/base\.(ts|js)/.test(text)) {
        throw new Error(`the payload did not smoke-run there (digest there ${there || 'none'}, here ${packed.digest}):\n${text.trim()}`)
      }

      say({ form: 'smoke', digest: there, version, made: made.split('\n').slice(-3).join(' | ') })
      failAt('smoke')

      return { packed, instance: machine.instance }
    },
  })

  say({ form: 'built', platform: 'windows-x64', file: out, digest: answer.packed.digest, bytes: answer.packed.bytes, minutes, dollars: (minutes / 60) * ec2.RATE, instance: answer.instance })
}

try {
  await main()
} catch (error) {
  say({ form: 'failed', message: ec2.redact(error instanceof Error ? error.message : String(error)) })
  process.exitCode = 1
}
