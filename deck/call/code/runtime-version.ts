// The runtime version of a native build (native-dom-0015): one sha256 over everything that decides whether a page
// update can run on an installed app. A page update ships TypeScript and assets only, so it is safe exactly when the
// native half it talks to is byte for byte the one it was built against: the same emitted program (which holds the
// generated dispatcher and its allowlist), the same runtime shims, the same target, minimum OS and toolchain.
//
// Expo answers this with @expo/fingerprint, which sha1-hashes a heuristic list of files with opt-outs, because an
// Expo app's native half is a hand-edited Xcode and Gradle project. Term's native half is GENERATED, so the input is
// a closed set the build already holds, and nothing is guessed. See note/term/app/13-expo-lessons.md, rank 2.
//
// The driver line that hands `boot` its page directory or dev URL is NOT an input: it differs between a dev build and
// a release of the same binary surface, and a dev URL must not make two identical natives incompatible.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { TONE_ALPHABET } from '@cluesurf/save/canon/mark'

import * as port from '@term/call/code/runtime-frame'

// THE FRAMING AND THE TONE are Term since 2026-10-06, call/code/runtime-frame.tree: every field length-prefixed, the
// sources sorted by name, and the digest in the tone alphabet. This face hashes the frame with node's sha256, which is
// synchronous where Term's is not, and asks the toolchain for its version.

export type RuntimeVersionInput = {
  // the cask target: macos, ios, android, linux, windows
  target: string
  // the lowest OS the binary runs on, which changes what the native half may call
  minimum: string
  // the first line of the native compiler's own version output (`toolchainOf`)
  toolchain: string
  // the native sources as built, by a stable name. Order does not matter: they are sorted by name
  sources: { name: string; text: string }[]
}

export type RuntimeVersion = {
  // 64 hex characters, what a manifest carries on the wire
  hex: string
  // the same digest in the tone alphabet, eight groups of eight, what a person reads
  tone: string
}

// every field length-prefixed, so no two different inputs can frame to the same bytes
export function runtimeVersion(input: RuntimeVersionInput): RuntimeVersion {
  const frame = port.frame(input.target, input.minimum, input.toolchain, input.sources.map(source => ({ name: source.name, text: source.text })))
  const hex = createHash('sha256').update(frame).digest('hex')

  return { hex, tone: toneOf(hex) }
}

// a sha256 in the tone alphabet, eight groups of eight. Never truncated
export function toneOf(hex: string): string {
  const bad = port.notHex(hex)

  if (bad !== '') {
    throw new Error(`toneOf: not hex: ${bad}`)
  }

  return port.toneOf(hex, TONE_ALPHABET)
}

const toolchains = new Map<string, string>()

// the native compiler's version line for a target, read once per process. A toolchain that is not installed answers
// `none`, which still hashes, so a version computed without the compiler can never equal one computed with it
export function toolchainOf(target: string): string {
  const command: [string, string[]] =
    target === 'macos' || target === 'ios'
      ? ['swiftc', ['--version']]
      : target === 'android'
        ? ['kotlinc', ['-version']]
        : ['rustc', ['--version']]
  const key = command[0]
  const known = toolchains.get(key)

  if (known !== undefined) {
    return known
  }

  // kotlinc prints its version on stderr and exits 0, swiftc and rustc print on stdout, so both are read
  const run = spawnSync(command[0], command[1], { encoding: 'utf8' })
  const line =
    run.error === undefined
      ? (`${run.stdout ?? ''}\n${run.stderr ?? ''}`.split('\n').find(l => l.trim())?.trim() ?? 'none')
      : 'none'

  toolchains.set(key, line)

  return line
}
