// The face component contract (native-dom-0009, 0011): a component the author writes once has a GENERIC
// implementation (`face/code/component/native/<name>.tree`, the abstract fallback) and may have one per platform rung
// (`native/toolkit/<name>.tree`, ...). The contract is the generic one's props: every platform implementation must take
// exactly the same names, in the same order, at the same types, so an author's `view <name> / bind ...` means the same
// thing on every platform. Read through the compiler's own parser and mill, never a second reader of `.tree`.
//
// It also holds the resolution the contract exists for: the web build gets the generic implementation and the macOS,
// iOS and Android builds get the toolkit one, through `component/<name>.tree` and the env chain.
// Run: npx tsx test/compile/face-contract.ts

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { compileProject, projectResolver } from '@term/call/code/make'
import { contractFindings, propsOf } from '@term/call/code/face-contract'
import type { NativeEnv } from '@term/make/code/compile/native'

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

const TERM = process.cwd()
const NATIVE = join(TERM, 'deck/face/code/component/native')

// every platform implementation face has, against its generic (deck/call/code/face-contract.ts)
const rungs = readdirSync(NATIVE, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
const implementations = rungs.flatMap(rung => readdirSync(join(NATIVE, rung)).filter(file => file.endsWith('.tree')))
ok('at least one component has a platform implementation', implementations.length > 0, JSON.stringify(rungs))
const faceFindings = contractFindings(NATIVE)
ok(`every one of face's ${implementations.length} platform implementations takes exactly its contract`, faceFindings.length === 0, JSON.stringify(faceFindings))

// the negative control: an implementation that drops a prop, and one that renames one, must not pass
{
  const generic = `view gauge\n  take host, like view\n  take value, like number\n  take label, like text\n`
  const contract = propsOf('generic.tree', generic, 'gauge')
  const dropped = propsOf('dropped.tree', `view gauge\n  take host, like view\n  take value, like number\n`, 'gauge')
  const renamed = propsOf('renamed.tree', `view gauge\n  take host, like view\n  take amount, like number\n  take label, like text\n`, 'gauge')
  const retyped = propsOf('retyped.tree', `view gauge\n  take host, like view\n  take value, like text\n  take label, like text\n`, 'gauge')
  ok('control: dropping a prop breaks the contract', JSON.stringify(dropped) !== JSON.stringify(contract))
  ok('control: renaming a prop breaks the contract', JSON.stringify(renamed) !== JSON.stringify(contract))
  ok('control: retyping a prop breaks the contract', JSON.stringify(retyped) !== JSON.stringify(contract))
}

// resolution: the same program reaches a different implementation per platform, without naming one
const PROGRAM = `load @term/face/code/component/switch
  find switch

load @term/face/code/logic/disclosure
  find make-disclosure

load @term/site/code/dom/dom
  find view
  find create-element

task main
  save root
    call create-element
      bind tag, text <main>
  save wifi
    call make-disclosure
      bind start, false
  call switch
    read root
    text <>
    read wifi
`

for (const [env, want, why] of [
  ['browser', 'switch-thumb', 'the generic switch (a button with a thumb part)'],
  ['macos', '"switch"', 'the toolkit switch (one platform control)'],
] as const) {
  const entry = join(TERM, 'tmp', 'face-contract.tree')
  const result = compile({ file: entry, text: PROGRAM }, { resolve: projectResolver(TERM, env as NativeEnv), env })
  const code = result.ok ? result.typescript : ''
  const generic = code.includes('switch-thumb')
  ok(`${env} builds the program`, result.ok, result.ok ? '' : result.diagnostics.slice(0, 3).map(d => d.message).join(' | '))
  ok(
    `${env} reaches ${why}`,
    want === 'switch-thumb' ? generic : !generic && code.includes('"switch"'),
    code.slice(0, 200),
  )
}

// AN APP SHADOWS ONE (native-dom-0025): an app with its own `code/component/native/toolkit/switch.tree` gets it on
// macOS, iOS and Android, face's generic still serves the web, and the app's shadow is held to the same contract
{
  // a fresh app per run, so a file one run wrote cannot change the next run's answer
  mkdirSync(join(TERM, 'tmp'), { recursive: true })
  const app = mkdtempSync(join(TERM, 'tmp', 'face-shadow-app-'))
  const shadowDir = join(app, 'code/component/native/toolkit')
  mkdirSync(shadowDir, { recursive: true })
  writeFileSync(join(app, 'deck.tree'), 'deck @app/face-shadow\n')

  const shadow = (props: string) => `load @term/site/code/view/render
  find element
load @term/site/code/dom/dom
  find view
load @term/face/code/logic/disclosure
  find disclosure-open
  find toggle-disclosure

view switch
${props}
  node switch
    bind data-slot, text <app-switch>
    hook click
      call toggle-disclosure
        bind self, read control
`
  const CONTRACT_PROPS = '  take host, like view\n  take class, like text\n  take control, like signal boolean'
  writeFileSync(join(shadowDir, 'switch.tree'), shadow(CONTRACT_PROPS))

  const entry = join(app, 'main.tree')

  for (const [env, wantApp] of [['macos', true], ['android', true], ['browser', false]] as const) {
    const result = compile({ file: entry, text: PROGRAM }, { resolve: projectResolver(app, env as NativeEnv), env })
    const code = result.ok ? result.typescript : ''
    ok(`app shadow: ${env} builds`, result.ok, result.ok ? '' : result.diagnostics.slice(0, 3).map(d => d.message).join(' | '))
    ok(
      `app shadow: ${env} reaches ${wantApp ? "the app's switch" : "face's generic switch"}`,
      wantApp ? code.includes('app-switch') : code.includes('switch-thumb') && !code.includes('app-switch'),
      code.slice(0, 200),
    )
  }

  const faceNative = NATIVE
  ok("app shadow: the app's switch takes exactly the contract", contractFindings(faceNative, join(app, 'code/component/native')).length === 0)

  // a shadow that drops `class` is a finding, naming the app's file
  writeFileSync(join(shadowDir, 'switch.tree'), shadow('  take host, like view\n  take control, like signal boolean'))
  const dropped = contractFindings(faceNative, join(app, 'code/component/native'))
  ok("app shadow: one that drops a prop is a contract finding, naming the app's file", dropped.length === 1 && dropped[0]!.file.includes('face-shadow-app'), JSON.stringify(dropped))
  // and `term make` on the app fails on it, not only this test
  const built = compileProject(app)
  ok(
    'app shadow: term make on the app fails on the broken shadow',
    built.failed > 0 && built.errors.some(e => e.includes("shadows face's switch")),
    JSON.stringify(built.errors).slice(0, 400),
  )

  // a shadow of a component face has no generic for shadows nothing
  writeFileSync(join(shadowDir, 'switch.tree'), shadow(CONTRACT_PROPS))
  writeFileSync(join(shadowDir, 'dial.tree'), 'view dial\n  take host, like view\n')
  const orphan = contractFindings(faceNative, join(app, 'code/component/native'))
  ok('app shadow: one of a component face does not have is a finding', orphan.length === 1 && orphan[0]!.component === 'dial', JSON.stringify(orphan))
}

console.log(`\nface-contract: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
