// A Term program built for Compose on the desktop JVM (compose-target): compiled for the `compose` env, which reaches
// deck/site/code/dom/native/toolkit/dom.tree through its chain and Kotlin's JVM natives below it, and whose runtime
// the prelude finds at toolkit/runtime/compose/native-view.kt (the shared Compose runtime and the desktop host), then
// built by kotlinc with the Compose compiler plugin into a jar, and run headless (TERM_WINDOW_AWAY=1: the runtime hosts the tree
// in Compose's desktop test host). A helper, not a suite: shared/ is not walked by the runner. Used by
// test/compile/compose-view.ts and the `compose` leg of ./toolkit-run.ts.
//
// The Compose libraries and the plugin come from `task/term/native/kotlin.sh compose-flags` (resolved by Gradle, which
// it fetches into the cache when none is installed). `-jvm-target 17`: Compose's inline functions are built for JVM 11
// and up, and kotlinc's default target cannot inline them.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { projectResolver } from '@term/call/code/make'

export type ComposeBuilt =
  | { form: 'skipped'; reason: string }
  | { form: 'failed'; stage: 'compile' | 'prelude' | 'flags' | 'build'; reason: string }
  | { form: 'built'; jar: string; classpath: string; main: string }

export type ComposeRan = { status: number | null; output: string; error: string }

function have(tool: string): boolean {
  return spawnSync('which', [tool], { encoding: 'utf8' }).status === 0
}

// compile `text` (entry file `<dir>/<name>.tree`) for Compose and build it. `root` is the Term root
export function buildCompose({ root, dir, name, text }: { root: string; dir: string; name: string; text: string }): ComposeBuilt {
  if (!have('kotlinc') || !have('java')) {
    return { form: 'skipped', reason: 'kotlinc or java not installed' }
  }

  // the `compose` env: the toolkit dom, Kotlin's JVM natives, and the runtime the prelude finds for it,
  // deck/site/code/dom/native/toolkit/runtime/compose/native-view.kt (the shared Compose runtime and the desktop host)
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const entry = join(dir, `${name}.tree`)
  writeFileSync(entry, text)
  const result = compile({ file: entry, text }, { resolve: projectResolver(root, 'compose'), env: 'compose' })

  if (!result.ok) {
    return { form: 'failed', stage: 'compile', reason: [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | ') }
  }

  const kotlin = emitKotlin(result.program)
  const prelude = nativePrelude(result.program, 'compose', readRuntime, kotlin)

  // the Compose runtime and not the Android one: no Android class may reach a desktop build
  if (!prelude.includes('fun CxTree(') || prelude.includes('android.widget')) {
    return { form: 'failed', stage: 'prelude', reason: 'the prelude does not hold the Compose runtime alone' }
  }

  const file = join(dir, `${name}.kt`)
  writeFileSync(file, `${hoistKotlinImports([prelude, kotlin].join('\n'))}\n`)

  let classpath = ''
  let plugin = ''

  try {
    const out = execFileSync('bash', [join(root, '../../../../task/term/native/kotlin.sh'), 'compose-flags'], { encoding: 'utf8' })
    ;[classpath = '', plugin = ''] = out.trim().split('\n')
  } catch (e) {
    return { form: 'failed', stage: 'flags', reason: String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 800) }
  }

  if (!classpath.includes('ui-desktop') || !plugin.endsWith('.jar')) {
    return { form: 'failed', stage: 'flags', reason: `no Compose classpath or plugin: ${plugin}` }
  }

  const jar = join(dir, `${name}.jar`)
  const built = spawnSync('kotlinc', [file, '-classpath', classpath, `-Xplugin=${plugin}`, '-jvm-target', '17', '-nowarn', '-d', jar], {
    encoding: 'utf8',
  })

  if (built.status !== 0) {
    const errors = `${built.stdout}${built.stderr}`.split('\n').filter(line => /error:/.test(line))

    return { form: 'failed', stage: 'build', reason: errors.slice(0, 8).join('\n') || built.stderr.slice(-800) }
  }

  // kotlinc names a file's top-level class after the file: `<name>.kt` holds `<Name>Kt`
  const main = `${name.charAt(0).toUpperCase()}${name.slice(1).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}Kt`

  return { form: 'built', jar, classpath, main }
}

// run a built program headless, answering what it printed
export function runCompose(built: { jar: string; classpath: string; main: string }): ComposeRan {
  const ran = spawnSync(
    'java',
    ['-Djava.awt.headless=true', '--enable-native-access=ALL-UNNAMED', '-classpath', `${built.jar}:${built.classpath}`, built.main],
    { encoding: 'utf8', env: { ...process.env, TERM_WINDOW_AWAY: '1' }, timeout: 180_000 },
  )

  return { status: ran.status, output: String(ran.stdout), error: String(ran.stderr) }
}
