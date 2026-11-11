// Secure storage on the Mac's Keychain (device-layer-0020), with no window and no DOM: one program, its `secret` loads
// resolved as a macOS build resolves them (the toolkit host, native-secret.swift), compiled with swiftc and run as a
// bare binary, which keeps its items under the service `term`. A secret is saved, read back, removed, found gone, and
// a second removal finds nothing. The keychain is then asked, without -w so it never asks for a value or a password,
// whether anything is left under the name. Skips without swiftc. Run: npx tsx test/compile/secret-native.ts
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tempDir } from '../temp'
import { runOn } from './shared/run-on'
import { projectResolver } from '@term/call/code/make'

const ROOT = join(import.meta.dirname, '..', '..')

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

if (process.platform !== 'darwin') {
  console.log('skip  secret-native  (the Keychain is on a Mac)')
  process.exit(0)
}

// The login keychain is written only in a person's session: over ssh it is locked to the program and every save
// answers `failed` (release 2.10.2 on the M3). Its settings are read without -w and without a password, and a refusal
// is a skip with the reason, never a failure of the program under test
const keychain = spawnSync('security', ['show-keychain-info'], { encoding: 'utf8' })

if (keychain.status !== 0) {
  console.log(
    `skip  secret-native  (the login keychain cannot be written here, as over ssh: ${(keychain.stderr ?? '').trim().slice(0, 160)})`,
  )
  process.exit(0)
}

const NAME =`term-secret-native-${process.pid}`
const SECRET = `term-value-${process.pid}-${Date.now()}`

const PROGRAM = `load @term/site/view/secret
  find save-secret
  find read-secret
  find remove-secret

task run
  like text
  save saved
    call save-secret
      text <${NAME}>
      text <${SECRET}>
  save replaced
    call save-secret
      text <${NAME}>
      text <${SECRET}-again>
  save held
    call read-secret
      text <${NAME}>
  save removed
    call remove-secret
      text <${NAME}>
  save gone
    call read-secret
      text <${NAME}>
  save again
    call remove-secret
      text <${NAME}>
  send back
    text <{saved}|{replaced}|{held}|{removed}|{gone}|{again}>
`

const ran = runOn({
  backend: 'swift',
  program: PROGRAM,
  resolve: () => projectResolver(ROOT, 'macos', ROOT),
  dir: tempDir('secret-native-'),
  name: 'secret',
})

if (ran.form === 'skipped') {
  console.log(`skip  secret-native  (${ran.reason})`)
  process.exit(0)
}

ok(
  'the program builds and runs against the Keychain',
  ran.form === 'ran',
  ran.form === 'ran'
    ? ''
    : `${ran.stage}: ${ran.reason.slice(0, 1200)}`,
)

if (ran.form === 'ran') {
  ok(
    'a secret is saved, replaced, read back, removed, gone, and a second removal finds nothing',
    ran.output === `saved|saved|${SECRET}-again|removed||absent`,
    ran.output,
  )
}

const left = spawnSync(
  'security',
  ['find-generic-password', '-s', 'term', '-a', NAME],
  { encoding: 'utf8' },
)
ok(
  'and the login keychain holds nothing under the name afterwards',
  left.status !== 0,
  `${left.status}`,
)

console.log(`\nsecret-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
