// `term make --emit <target> <file> --build` (and `--run`): the emitted program with the main that calls it, built by
// its toolchain, and run. Until 2026-10-05 `--emit` wrote source and built nothing, and the toolchain call and the main
// were the caller's (guides: applications/backends). The main is compile/native-main.ts, the one every test harness
// appends too, so a program runs the same way here and in the suites.
//
// The entry is the task `--main` names, else `run`, else `boot`, else `main`. What it answers is printed, with no line
// break after it; an entry that answers nothing prints nothing. A raise ends with its message on stderr and exit 1.
//
//   node     the TypeScript bundled by esbuild into one ES module, run by node
//   rust     rustc, or a cargo project with the stdlib's crates the program names (num-bigint, regex, ...)
//   swift    swiftc, with the flags the native cache keeps (call/code/cask.ts `swiftFlags`)
//   kotlin   kotlinc to a jar with the Kotlin runtime in it, run by java
//
// The build goes in `--out <folder>` (default host/<target>/ under the project), named for the source file.

import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { buildSync } from 'esbuild'
import { cratesNamed, entryOf, nativeMain } from '@term/make/code/compile/native-main'
import type { EmitTarget } from '@term/make/code/compile/emit-target'
import { swiftFlags } from '@term/call/code/cask'
import { stdlibBase } from '@term/make/code/resolve'

export type Built = { ok: true; command: string[]; artifact: string } | { ok: false; reason: string }

// the toolchain each target needs
const TOOLS: Record<EmitTarget, string[]> = { node: [], rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }

function have(tool: string): boolean {
  return spawnSync('which', [tool], { encoding: 'utf8' }).status === 0
}

// a toolchain's errors, not the warnings in front of them
function errorsOf(error: unknown): string {
  const text = String((error as { stderr?: Buffer }).stderr ?? error)
  const errors = text.split('\n').filter(line => /error:|^e: |^error\[|^\s+--> /.test(line))

  return (errors.length > 0 ? errors.join('\n') : text).slice(0, 4000)
}

function tool(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string | undefined {
  try {
    execFileSync(command, args, { stdio: 'pipe', cwd, env })

    return undefined
  } catch (error) {
    return errorsOf(error)
  }
}

// build `source` (the emitted program, prelude and all, no main) for `target` into `folder`, as `name`
export function buildNative(input: { source: string; target: EmitTarget; folder: string; name: string; entry?: string }): Built {
  const missing = TOOLS[input.target].filter(one => !have(one))

  if (missing.length > 0) {
    return { ok: false, reason: `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not installed, which a ${input.target} build needs` }
  }

  const entry = entryOf(input.target, input.source, input.entry)

  if (!entry) {
    return {
      ok: false,
      reason: input.entry
        ? `the program has no task \`${input.entry}\` taking nothing, which --main names`
        : 'the program has no `run`, `boot` or `main` task taking nothing to start it. Name one with --main',
    }
  }

  mkdirSync(input.folder, { recursive: true })
  const stem = path.join(input.folder, input.name)

  if (input.target === 'node') {
    const file = `${stem}.ts`
    writeFileSync(file, `${input.source}\nPromise.resolve(${entry}()).then(answer => { if (answer !== undefined) process.stdout.write(String(answer)) }, error => { console.error(error); process.exit(1) })\n`)
    const artifact = `${stem}.mjs`

    try {
      buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', outfile: artifact, logLevel: 'silent' })
    } catch (error) {
      return { ok: false, reason: errorsOf(error) }
    }

    return { ok: true, command: [process.execPath, artifact], artifact }
  }

  if (input.target === 'rust') {
    const source = `${input.source}\n${nativeMain('rust', input.source, entry)}\n`
    const stdlib = stdlibBase()
    const cargoToml = stdlib ? path.join(stdlib, 'code/native/rust/Cargo.toml') : undefined
    const crates = cratesNamed(source, cargoToml && existsSync(cargoToml) ? readFileSync(cargoToml, 'utf8') : '')

    // a program that names a crate is a cargo project with those crates alone
    if (crates.length > 0) {
      if (!have('cargo')) {
        return { ok: false, reason: `cargo is not installed, and the program names ${crates.map(line => line.split(/\s*=/)[0]).join(', ')}` }
      }

      const project = `${stem}-cargo`
      const binary = input.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()
      mkdirSync(path.join(project, 'src'), { recursive: true })
      writeFileSync(path.join(project, 'Cargo.toml'), `[package]\nname = "${binary}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n${crates.join('\n')}\n\n[profile.release]\npanic = "abort"\n`)
      writeFileSync(path.join(project, 'src', 'main.rs'), source)
      const failed = tool('cargo', ['build', '--release', '--quiet'], project)

      if (failed) {
        return { ok: false, reason: failed }
      }

      const artifact = path.join(project, 'target', 'release', binary)

      return { ok: true, command: [artifact], artifact }
    }

    const file = `${stem}.rs`
    writeFileSync(file, source)
    const failed = tool('rustc', ['--edition', '2021', '-O', '-A', 'warnings', '-o', stem, file])

    return failed ? { ok: false, reason: failed } : { ok: true, command: [stem], artifact: stem }
  }

  if (input.target === 'swift') {
    const file = `${stem}.swift`
    writeFileSync(file, `import Foundation\n${input.source}\n${nativeMain('swift', input.source, entry)}\n`)
    const failed = tool('swiftc', [...swiftFlags(), '-O', '-o', stem, file])

    return failed ? { ok: false, reason: failed } : { ok: true, command: [stem], artifact: stem }
  }

  const file = `${stem}.kt`
  writeFileSync(file, `${input.source}\n${nativeMain('kotlin', input.source, entry)}\n`)
  const artifact = `${stem}.jar`
  const failed = tool('kotlinc', [file, '-include-runtime', '-nowarn', '-d', artifact])

  return failed ? { ok: false, reason: failed } : { ok: true, command: ['java', '-jar', artifact], artifact }
}

// THE TWO TARGETS THROUGH RUST (note/term/plan/backends-complete.md, step 4): the program's Rust, and then
//
//   llvm   rustc's LLVM IR, a `.ll`. Built by `llc` from rustup's `llvm-tools`, the one whose LLVM is rustc's own, and
//          linked against rustc's std. Apple's clang reads an older LLVM and refuses the IR rustc writes (measured on
//          2026-10-05: clang 21 against rustc 1.99's LLVM 23, "Intrinsic has incorrect argument type")
//   wasm   a WebAssembly module for WASI (`--target wasm32-wasip1`), run by node's own WASI
//
// A program that names a crate is refused for both: the crates the runtime reaches do not all build for WASI, and an
// IR file is one compilation unit with no crates beside it. A missing tool is refused with the command that installs it.
export type ThroughRust = 'llvm' | 'wasm'

const host = (): string => {
  const verbose = spawnSync('rustc', ['--version', '--verbose'], { encoding: 'utf8' }).stdout ?? ''

  return /^host: (.+)$/m.exec(verbose)?.[1]?.trim() ?? ''
}

const sysroot = (): string => (spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).stdout ?? '').trim()

// the IR (`llvm`) or the module (`wasm`) of the program's Rust source, written to `folder`, built and runnable when the
// tools are there
export function buildThroughRust(input: { source: string; target: ThroughRust; folder: string; name: string; entry?: string; build: boolean }): Built {
  if (!have('rustc')) {
    return { ok: false, reason: 'rustc is not installed, which both llvm and wasm are built through' }
  }

  const entry = entryOf('rust', input.source, input.entry)

  if (!entry) {
    return { ok: false, reason: 'the program has no `run`, `boot` or `main` task taking nothing to start it. Name one with --main' }
  }

  const stdlib = stdlibBase()
  const cargoToml = stdlib ? path.join(stdlib, 'code/native/rust/Cargo.toml') : undefined
  const source = `${input.source}\n${nativeMain('rust', input.source, entry, input.target !== 'wasm')}\n`
  const crates = cratesNamed(source, cargoToml && existsSync(cargoToml) ? readFileSync(cargoToml, 'utf8') : '')

  if (crates.length > 0) {
    return { ok: false, reason: `the program names ${crates.map(line => line.split(/\s*=/)[0]).join(', ')}, and a ${input.target} build takes no crates` }
  }

  mkdirSync(input.folder, { recursive: true })
  const stem = path.join(input.folder, input.name)
  writeFileSync(`${stem}.rs`, source)

  if (input.target === 'wasm') {
    const libdir = path.join(sysroot(), 'lib', 'rustlib', 'wasm32-wasip1', 'lib')

    if (!existsSync(libdir)) {
      return { ok: false, reason: 'the wasm32-wasip1 target is not installed: rustup target add wasm32-wasip1' }
    }

    const module = `${stem}.wasm`
    const failed = tool('rustc', ['--edition', '2021', '-O', '-A', 'warnings', '--target', 'wasm32-wasip1', '-o', module, `${stem}.rs`])

    if (failed) {
      return { ok: false, reason: failed }
    }

    // node runs it under its own WASI, the program's stdout and exit code its own
    const runner = `${stem}.mjs`
    writeFileSync(
      runner,
      `import { readFileSync } from 'node:fs'\nimport { WASI } from 'node:wasi'\nconst wasi = new WASI({ version: 'preview1', args: [], env: {}, returnOnExit: true })\nconst { instance } = await WebAssembly.instantiate(readFileSync(new URL('./${input.name}.wasm', import.meta.url)), wasi.getImportObject())\nprocess.exitCode = wasi.start(instance)\n`,
    )

    return { ok: true, command: [process.execPath, '--no-warnings', runner], artifact: module }
  }

  // llvm: the IR, always; built only when asked
  const ir = `${stem}.ll`
  const emitted = tool('rustc', ['--edition', '2021', '-O', '-A', 'warnings', '--emit=llvm-ir', '-o', ir, `${stem}.rs`])

  if (emitted) {
    return { ok: false, reason: emitted }
  }

  if (!input.build) {
    return { ok: true, command: [], artifact: ir }
  }

  const triple = host()
  const llc = path.join(sysroot(), 'lib', 'rustlib', triple, 'bin', 'llc')

  if (!existsSync(llc)) {
    return { ok: false, reason: `llc is not installed: it comes with rustup's llvm-tools, whose LLVM is rustc's own: rustup component add llvm-tools` }
  }

  const object = `${stem}.o`
  const compiled = tool(llc, ['-O2', '-filetype=obj', '-o', object, ir])

  if (compiled) {
    return { ok: false, reason: compiled }
  }

  // linked against rustc's own std, the dynamic one, found again at run time through the rpath
  const libdir = path.join(sysroot(), 'lib', 'rustlib', triple, 'lib')
  const std = spawnSync('ls', [libdir], { encoding: 'utf8' }).stdout.split('\n').find(one => /^libstd-.*\.(dylib|so)$/.test(one))

  if (!std) {
    return { ok: false, reason: `rustc's dynamic std is not in ${libdir}` }
  }

  const linked = tool('cc', [object, '-o', stem, `-L${libdir}`, `-l${std.replace(/^lib/, '').replace(/\.(dylib|so)$/, '')}`, `-Wl,-rpath,${libdir}`])

  return linked ? { ok: false, reason: linked } : { ok: true, command: [stem], artifact: stem }
}

// run a built program, its output and its exit code passed through
export function runBuilt(command: string[]): number {
  const ran = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit' })

  return ran.status ?? 1
}
