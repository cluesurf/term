// The dependency flags the swift and kotlin toolchains need to see the stdlib's standard stacks.
//
// The native shims are no longer Foundation-and-JDK only: the asynchronous filesystem is NIOFileSystem on swift
// and kotlinx-coroutines on kotlin, and the HTTP server is Hummingbird and Ktor. A bare `swiftc -typecheck f.swift`
// or `kotlinc f.kt` cannot see a package or a classpath, so any harness that compiles a program whose closure
// reaches `file/*` or `network/server` fails with `no such module '_NIOFileSystem'` or an unresolved
// `kotlinx.coroutines` from a line that mentions neither.
//
// task/term/native/{swift,kotlin}.sh own the resolving and the cache. This only reads what they wrote, so a
// harness and the gate cannot disagree about which swift-nio the code was checked against. The answer is cached
// for the process: the scripts are cheap when warm but not free, and a harness calls this once per compile.
//
// rust needs nothing here: cargo reads the Cargo.toml the harness writes.

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// this file is at <repo>/deck/term/deck/term/test/compile/, which is SIX levels down: compile, test, term, deck,
// term, deck. Off by one and the scripts are simply not found, `flags` returns empty, and every build fails with
// an unresolved import from a file that imports it perfectly well.
const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../..',
)

const held = new Map<string, string[]>()

export function nativeFlags(env: 'swift' | 'kotlin'): string[] {
  const already = held.get(env)

  if (already) {
    return already
  }

  let flags: string[] = []

  try {
    const out = execFileSync(
      'bash',
      [join(ROOT, `task/term/native/${env}.sh`), 'flags'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    )

    // swift writes one argument per line, kotlin writes a single classpath string
    flags =
      env === 'kotlin'
        ? ['-classpath', out.trim()]
        : out.split('\n').filter(line => line.length > 0)
  } catch {
    console.log(
      `warn  ${env}: no dependency flags. Run \`pnpm term:${env} deps\`. Anything whose closure reaches the standard stack will fail to build.`,
    )
  }

  held.set(env, flags)

  return flags
}
