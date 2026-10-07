// A dotted `dock type` whose head is a SHIM NAMESPACE needs no module import (compile/swift.ts, the `shimNames` rule).
// `load <runtime.Running>` beside `load <global:server>, name runtime` names a type inside the prepended shim's
// `enum runtime`, which is already in scope. The rule compared the shim's alias as written (`watch-file`) with the
// head as typed (`watchFile`), so a two-word alias never matched and the file said `import watchFile`, which swiftc
// answers `no such module` (D026, item 0211). It now compares in the spelling a native call writes the namespace
// (`watchFile.watchOpen(`), from the one function every emitted name comes from.
// Emits Swift only, no swiftc.
// Run: npx tsx test/compile/swift-shim-namespace.ts

import { compile } from '@term/make/code/compile/compile'
import { emitSwift } from '@term/make/code/compile/swift'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

// the emitted Swift of one program, or the diagnostics that stopped it
function swiftOf(text: string): { swift: string } | { failed: string } {
  const built = compile({ file: 'shim-namespace.tree', text }, { resolve: withNativeEnv('swift', stdlibResolver()!), env: 'swift' })

  if (!built.ok) {
    return { failed: built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ') }
  }

  return { swift: emitSwift(built.program) }
}

const imports = (swift: string): string[] => swift.split('\n').filter(line => /^import /.test(line))

function program(dockType: string, dockLoad: string): string {
  return `dock type
  load <${dockType}>, name handle-dock
${dockLoad}
form handle
  link dock, like handle-dock, mark private

task nothing
  like integer
  send back, code 1
`
}

function holds(name: string, text: string, check: (lines: string[]) => boolean, want: string): void {
  const out = swiftOf(text)

  if ('failed' in out) {
    ok(name, false, out.failed)
  } else {
    ok(name, check(imports(out.swift)), `${want}; imports: ${imports(out.swift).join(' | ')}`)
  }
}

// a kebab alias: the type names the camelCase namespace the shim declares
holds(
  'a kebab alias (foo-bar) shims <fooBar.Thing>: no import fooBar',
  program('fooBar.Thing', 'dock load\n  load <global:foo-bar>, name foo-bar\n'),
  lines => !lines.includes('import fooBar'),
  'no import fooBar',
)

// today's rule, kept: a single-word alias
holds(
  'a single-word alias (runtime) shims <runtime.Running>: no import runtime',
  program('runtime.Running', 'dock load\n  load <global:server>, name runtime\n'),
  lines => !lines.includes('import runtime'),
  'no import runtime',
)

// kept: a head no shim owns is a module and is imported
holds(
  '<SwiftUI.AnyView> with no shim: import SwiftUI is emitted',
  program('SwiftUI.AnyView', ''),
  lines => lines.includes('import SwiftUI'),
  'import SwiftUI',
)

// the real case: the stdlib's swift file/watch binding, `<watchFile.Watcher>` beside `name watch-file`
{
  const text = `load @term/base/file/watch
  find watch
  find watcher

task open
  mark async
  take path, like text
  like watcher
  send back
    call watch
      read path
`
  const built = compile({ file: 'shim-namespace.tree', text }, { resolve: withNativeEnv('swift', stdlibResolver()!), env: 'swift' })

  if (!built.ok) {
    ok('a program that loads @term/base/file/watch: no import watchFile', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
  } else {
    const natives = built.program.filter(n => n.form === 'native') as Array<{ kind?: string; module: string; alias: string }>
    const dotted = natives.some(n => n.kind === 'type' && n.module === 'watchFile.Watcher')
    const kebab = natives.some(n => n.module.startsWith('global:') && n.alias === 'watch-file')
    const lines = imports(emitSwift(built.program))
    ok(
      'a program that loads @term/base/file/watch: no import watchFile',
      dotted && kebab && !lines.includes('import watchFile'),
      `the program holds <watchFile.Watcher> ${dotted} and alias watch-file ${kebab} (both must be true or this proves nothing); imports: ${lines.join(' | ')}`,
    )
  }
}

console.log(`\nswift-shim-namespace: ${pass} ok, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
