// Builds and runs the MPFR oracle (oracle.c, spec.md section 5).
//
// The binary goes to tmp/float/oracle under the repository root and is rebuilt
// when oracle.c is newer. `oracleWords(verb, inputs)` answers one result word
// per input, each a bigint of the binary64 bits.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_ROOT } from '../root'

const here = dirname(fileURLToPath(import.meta.url))
const repository = TERM_ROOT
const source = join(here, 'oracle.c')
const directory = join(repository, 'tmp', 'float')
export const ORACLE_BINARY = join(directory, 'oracle')

export const UNARY_VERBS = [
  'exponent',
  'natural-logarithm',
  'logarithm-2',
  'logarithm-10',
  'sine',
  'cosine',
  'tangent',
  'arc-sine',
  'arc-cosine',
  'arc-tangent',
  'hyperbolic-sine',
  'hyperbolic-cosine',
  'hyperbolic-tangent',
] as const

export const BINARY_VERBS = ['arc-tangent-of', 'hypotenuse', 'power'] as const

export const VERBS: readonly string[] = [...UNARY_VERBS, ...BINARY_VERBS]

export function isBinary(verb: string): boolean {
  return (BINARY_VERBS as readonly string[]).includes(verb)
}

export function ensureOracle(): string {
  const stale =
    !existsSync(ORACLE_BINARY) || statSync(ORACLE_BINARY).mtimeMs < statSync(source).mtimeMs
  if (stale) {
    mkdirSync(directory, { recursive: true })
    execFileSync('clang', [
      '-O2',
      '-I/opt/homebrew/opt/mpfr/include',
      '-I/opt/homebrew/opt/gmp/include',
      '-L/opt/homebrew/opt/mpfr/lib',
      '-L/opt/homebrew/opt/gmp/lib',
      '-o',
      ORACLE_BINARY,
      source,
      '-lmpfr',
      '-lgmp',
    ])
  }
  return ORACLE_BINARY
}

export function hex(word: bigint): string {
  return word.toString(16).padStart(16, '0')
}

// inputs: one array per call, one word (two for the binary verbs).
export function oracleWords(verb: string, inputs: bigint[][]): bigint[] {
  const binary = ensureOracle()
  const text = inputs.map(row => row.map(hex).join(' ')).join('\n') + '\n'
  const output = execFileSync(binary, [verb], {
    input: text,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const lines = output.split('\n').filter(line => line.length > 0)
  if (lines.length !== inputs.length) {
    throw new Error(`oracle ${verb}: ${lines.length} answers for ${inputs.length} inputs`)
  }
  return lines.map(line => BigInt('0x' + line))
}
