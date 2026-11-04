/**
 * Does the TypeScript the compiler emits actually typecheck?
 *
 * `pnpm term:unknown-types` asks a different question and answers it better:
 * whether any `like <name>` in the source names nothing the CHECKER knows. It
 * reports zero. This asks whether the emitted modules are self-consistent, and
 * the two disagree, because a name the checker resolves can still be emitted as
 * a reference the emitter never defines or imports.
 *
 * Measured 2026-08-29 over a 505-module build of the stdlib: 528 TS2304
 * "cannot find name" errors across 116 emitted modules, among them Term,
 * FaceLink, Face, Cite and Site in `code/host.ts`, while `term:unknown-types`
 * reported 0 sites across 749 modules on the same tree.
 *
 * Runs `tsc --noEmit` over a directory of emitted `.ts`. Reports by default and
 * writes nothing, ever.
 *
 *   pnpm term:emit-check <dir of emitted .ts>
 *
 * A regex approximation of this lived here first and was wrong in both
 * directions: it missed most of the 528 and flagged files tsc says are clean.
 * The real compiler is the instrument.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      walk(path, out)
    } else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
      out.push(path)
    }
  }

  return out
}

const target = process.argv[2]

if (!target) {
  console.error('usage: pnpm term:emit-check <dir of emitted .ts>')
  process.exit(2)
}

const files = walk(target)

if (files.length === 0) {
  console.log('no emitted modules found')
  process.exit(0)
}

let output = ''

try {
  execFileSync(
    'npx',
    [
      'tsc', '--noEmit', '--skipLibCheck',
      '--target', 'es2023',
      '--moduleResolution', 'bundler',
      '--module', 'esnext',
      ...files,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
} catch (error) {
  const shape = error as { stdout?: string; stderr?: string }
  output = `${shape.stdout ?? ''}${shape.stderr ?? ''}`
}

const lines = output.split('\n').filter(line => /error TS/.test(line))
const missing = lines.filter(line => /TS2304/.test(line))
const places = new Set(missing.map(line => line.split('(')[0]))

console.log(`${files.length} emitted modules typechecked`)

if (lines.length === 0) {
  console.log('no errors')
  process.exit(0)
}

for (const line of missing.slice(0, 40)) {
  console.log(`  ${line}`)
}

if (missing.length > 40) {
  console.log(`  ... and ${missing.length - 40} more`)
}

// every OTHER error too: counting them in the total and printing none sent the reader to run tsc by hand to learn
// what 18 errors were (2026-10-02)
const other = lines.filter(line => !/TS2304/.test(line))

for (const line of other.slice(0, 40)) {
  console.log(`  ${line}`)
}

if (other.length > 40) {
  console.log(`  ... and ${other.length - 40} more`)
}

console.log(
  `\n${missing.length} undefined name(s) across ${places.size} module(s), ` +
    `${lines.length} error(s) in total`,
)
process.exit(1)
