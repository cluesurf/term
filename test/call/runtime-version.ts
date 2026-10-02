// The runtime version of a native build (native-dom-0015): the hash a page update is checked against. It must be the
// same for the same native half, whatever order the sources arrive in, and different the moment anything that decides
// compatibility differs: one byte of a source, the target, the minimum OS, the toolchain. Length framing must keep
// two different splits of the same bytes apart. Run: npx tsx test/call/runtime-version.ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeVersion, toneOf, toolchainOf } from '@term/call/code/runtime-version'
import { stampRuntimeVersion } from '@term/call/code/cask'

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

const base = {
  target: 'macos',
  minimum: '14.0',
  toolchain: 'swift-driver version: 1.0 Apple Swift version 6.2',
  sources: [
    { name: 'app.swift', text: 'func boot() {}\n' },
    { name: 'runtime/cask.swift', text: 'final class Cask {}\n' },
  ],
}

const v = runtimeVersion(base)

ok('the hex is a sha256', /^[0-9a-f]{64}$/.test(v.hex), v.hex)
ok('the tone is eight groups of eight', /^([mndbtkhsfvzxcwlr]{8}-){7}[mndbtkhsfvzxcwlr]{8}$/.test(v.tone), v.tone)
ok('the tone is the hex re-lettered, nothing dropped', v.tone.replaceAll('-', '').length === 64)
ok('the same input gives the same version', runtimeVersion(base).hex === v.hex)
ok(
  'source order does not matter',
  runtimeVersion({ ...base, sources: [...base.sources].reverse() }).hex === v.hex,
)
ok(
  'one byte of one source changes it',
  runtimeVersion({ ...base, sources: [base.sources[0], { ...base.sources[1], text: 'final class Cask { }\n' }] }).hex !== v.hex,
)
ok('the target changes it', runtimeVersion({ ...base, target: 'ios' }).hex !== v.hex)
ok('the minimum OS changes it', runtimeVersion({ ...base, minimum: '15.0' }).hex !== v.hex)
ok('the toolchain changes it', runtimeVersion({ ...base, toolchain: 'swift 6.3' }).hex !== v.hex)
ok(
  'a source renamed changes it',
  runtimeVersion({ ...base, sources: [{ ...base.sources[0], name: 'main.swift' }, base.sources[1]] }).hex !== v.hex,
)

// the framing: the same bytes split differently between name and text must not collide
const a = runtimeVersion({ ...base, sources: [{ name: 'ab', text: 'c' }] })
const b = runtimeVersion({ ...base, sources: [{ name: 'a', text: 'bc' }] })
ok('framing keeps two splits of the same bytes apart', a.hex !== b.hex)

ok('toneOf letters 0 as m and f as r', toneOf('0f') === 'mr')
ok('toneOf refuses a non-hex character', (() => {
  try {
    toneOf('0g')

    return false
  } catch {
    return true
  }
})())

// the toolchain line is read from the compiler, and an absent one is `none` rather than an empty string
const line = toolchainOf('linux')
ok('a toolchain line is never empty', line.length > 0, line)

// what `term make --target` writes into the app: the hex, one line, in a file named `runtime-version`, and the same
// native half stamps the same version every time
{
  const into = mkdtempSync(join(tmpdir(), 'term-runtime-version-'))
  const first = stampRuntimeVersion({ target: 'android', native: 'class Program {}\n', into })
  const written = readFileSync(join(into, 'runtime-version'), 'utf8')
  ok('the build writes the hex into the app', written === `${first.hex}\n`, JSON.stringify(written))
  ok('the same native half stamps the same version', stampRuntimeVersion({ target: 'android', native: 'class Program {}\n', into }).hex === first.hex)
  ok('a different native half stamps a different one', stampRuntimeVersion({ target: 'android', native: 'class Program { }\n', into }).hex !== first.hex)
}

console.log(`\nruntime-version: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
