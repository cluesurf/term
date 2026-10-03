// The Rust runtime's base64, written with the standard library rather than the base64 crate so a program builds with a
// bare rustc (deck/base/code/native/rust/runtime/octets.rs and base64.rs). Both are built against the RFC 4648 section
// 10 test vectors in both directions, every byte value round trips, and malformed input decodes to nothing, as the
// crate's `unwrap_or_default` did. Skipped without rustc.
// Run: npx tsx test/compile/rust-base64.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNTIME = join(process.cwd(), 'deck/base/code/native/rust/runtime')
const VECTORS = [['', ''], ['f', 'Zg=='], ['fo', 'Zm8='], ['foo', 'Zm9v'], ['foob', 'Zm9vYg=='], ['fooba', 'Zm9vYmE='], ['foobar', 'Zm9vYmFy']]

if (spawnSync('which', ['rustc'], { encoding: 'utf8' }).status !== 0) {
  console.log('skip  rustc not installed\n\nrust-base64: 0 pass, 0 fail')
  process.exit(0)
}

// a vector named in a check's label, in single quotes so it sits inside the Rust string
const quoted = (value: string): string => `'${value}'`

const checks = VECTORS.flatMap(([plain, coded]) => [
  `check(octets::to_base64(${JSON.stringify(plain)}.as_bytes().to_vec()) == ${JSON.stringify(coded)}, "bytes encode ${quoted(plain!)}");`,
  `check(octets::from_base64(${JSON.stringify(coded)}.to_string()) == ${JSON.stringify(plain)}.as_bytes().to_vec(), "bytes decode ${quoted(coded!)}");`,
  `check(base64::encode(${JSON.stringify(plain)}.to_string()) == ${JSON.stringify(coded)}, "text encode ${quoted(plain!)}");`,
  `check(base64::decode(${JSON.stringify(coded)}.to_string()) == ${JSON.stringify(plain)}, "text decode ${quoted(coded!)}");`,
])

const program = [
  readFileSync(join(RUNTIME, 'octets.rs'), 'utf8'),
  readFileSync(join(RUNTIME, 'base64.rs'), 'utf8'),
  'fn check(ok: bool, name: &str) { if ok { println!("ok    {}", name) } else { println!("FAIL  {}", name) } }',
  'fn main() {',
  ...checks,
  '    check(octets::from_base64("Zm9v!".to_string()).is_empty(), "malformed bytes decode to nothing");',
  '    check(base64::decode("@@@@".to_string()).is_empty(), "malformed text decodes to nothing");',
  '    let all: Vec<u8> = (0..=255u8).collect();',
  '    check(octets::from_base64(octets::to_base64(all.clone())) == all, "every byte value round trips");',
  '}',
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'term-rust-base64-'))
writeFileSync(join(dir, 'base64.rs'), program)
execFileSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', join(dir, 'base64'), join(dir, 'base64.rs')])
const output = execFileSync(join(dir, 'base64'), { encoding: 'utf8' })
process.stdout.write(output)

const pass = output.split('\n').filter(line => line.startsWith('ok')).length
const fail = output.split('\n').filter(line => line.startsWith('FAIL')).length
console.log(`\nrust-base64: ${pass} pass, ${fail} fail`)

if (fail > 0 || pass === 0) {
  process.exit(1)
}
