// A Term program built for Jetpack Compose on Android (compose-target-0004), with no Android Gradle plugin: the toolkit
// dom compiled for the `android` env, the Compose runtime (deck/site/code/dom/native/compose/runtime/native-view.kt and
// host-android.kt) read where the Android views runtime would be, then an APK made by hand from Compose's Android
// libraries, the way the cask's APK pipeline (deck/call/code/cask.ts) makes one with no Gradle:
//
//   1. the libraries: every `.aar` and `.jar` `task/term/native/kotlin.sh compose-android-files` resolves
//   2. each `.aar` unpacked: its classes, its bundled jars, its resources and its package name
//   3. aapt2 compiles each library's resources, then links them all with the app's manifest into the base APK, writing
//      an R class for the app AND for every library package, which the libraries' own code reads its resources through
//   4. kotlinc builds the program with the Compose compiler plugin against android.jar and the libraries
//   5. d8 dexes the program, the R classes and every library into as many dex files as it takes
//   6. the dex files go into the base APK, which is aligned and signed with the debug key
//
// A helper, not a suite: shared/ is not walked by the runner. Used by test/compile/compose-view.ts.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { projectResolver } from '@term/call/code/make'
import { androidDevice, androidTools } from '@term/call/code/cask'
import { spawnSync } from 'node:child_process'

export type ComposeAndroidBuilt =
  | { form: 'skipped'; reason: string }
  | { form: 'failed'; stage: string; reason: string }
  | { form: 'built'; apk: string }

// the same floor and target as the cask's APKs
const MINIMUM_SDK = 26
const TARGET_SDK = 36

// a command's failure as its errors, not the warnings around them
function failure(error: unknown): string {
  const said = error as { stderr?: Buffer; stdout?: Buffer }
  const text = `${String(said.stdout ?? '')}${String(said.stderr ?? '')}` || String(error)
  const errors = text.split('\n').filter(line => /error|e: |Exception/.test(line))

  return (errors.length > 0 ? errors.slice(0, 12).join('\n') : text.slice(-1200)).slice(0, 2400)
}

function run(command: string, args: string[], cwd?: string): void {
  execFileSync(command, args, { stdio: 'pipe', cwd, maxBuffer: 64 * 1024 * 1024 })
}

// every file under `dir` whose name ends with `suffix`
function filesUnder(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) {
    return []
  }

  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)

    return statSync(full).isDirectory() ? filesUnder(full, suffix) : name.endsWith(suffix) ? [full] : []
  })
}

export function buildComposeAndroid({
  root,
  dir,
  name,
  text,
  identifier,
}: {
  root: string
  dir: string
  name: string
  text: string
  identifier: string
}): ComposeAndroidBuilt {
  let tools: ReturnType<typeof androidTools>

  try {
    tools = androidTools()
  } catch (e) {
    return { form: 'skipped', reason: String((e as Error).message ?? e) }
  }

  const work = join(dir, `${name}-android`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  // the `compose-android` env: Android's natives, the toolkit dom, and the runtime the prelude finds for it,
  // deck/site/code/dom/native/toolkit/runtime/compose-android/native-view.kt (the shared Compose runtime and the Android
  // host)
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const entry = join(work, `${name}.tree`)
  writeFileSync(entry, text)
  const result = compile({ file: entry, text }, { resolve: projectResolver(root, 'compose-android'), env: 'compose-android' })

  if (!result.ok) {
    return { form: 'failed', stage: 'compile', reason: [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | ') }
  }

  const kotlin = emitKotlin(result.program)
  const prelude = nativePrelude(result.program, 'compose-android', readRuntime, kotlin)
  const driver = ['class TermActivity : TermComposeActivity() {', '  override fun program() { main() }', '}'].join('\n')
  const source = join(work, 'app.kt')
  writeFileSync(source, `package ${identifier}\n\n${hoistKotlinImports([prelude, kotlin, driver].join('\n'))}\n`)

  // 1. the libraries and the compiler plugin
  const script = join(root, '../../../../task/term/native/kotlin.sh')
  let files: string[]
  let plugin: string

  try {
    files = execFileSync('bash', [script, 'compose-android-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    plugin = execFileSync('bash', [script, 'compose-flags'], { encoding: 'utf8' }).trim().split('\n')[1] ?? ''
  } catch (e) {
    return { form: 'failed', stage: 'libraries', reason: failure(e) }
  }

  // 2. each `.aar` unpacked: its classes and bundled jars onto the classpath, its resources compiled, its package kept
  const jars = files.filter(file => file.endsWith('.jar'))
  const flats: string[] = []
  const packages = new Set<string>()

  try {
    files
      .filter(file => file.endsWith('.aar'))
      .forEach((aar, index) => {
        const into = join(work, 'aar', String(index))
        mkdirSync(into, { recursive: true })
        run('unzip', ['-q', '-o', aar, '-d', into])
        const classes = join(into, 'classes.jar')

        if (existsSync(classes)) {
          jars.push(classes)
        }

        jars.push(...filesUnder(join(into, 'libs'), '.jar'))
        const manifest = join(into, 'AndroidManifest.xml')
        const found = existsSync(manifest) ? /package="([^"]+)"/.exec(readFileSync(manifest, 'utf8')) : null

        if (found) {
          packages.add(found[1]!)
        }

        // 3. its resources compiled, when it has any
        const res = join(into, 'res')

        if (filesUnder(res, '').length > 0) {
          const flat = join(work, 'flat', `${index}.zip`)
          mkdirSync(join(work, 'flat'), { recursive: true })
          run(join(tools.buildTools, 'aapt2'), ['compile', '--dir', res, '-o', flat])
          flats.push(flat)
        }
      })
  } catch (e) {
    return { form: 'failed', stage: 'unpack', reason: failure(e) }
  }

  // 3. one link: the app's manifest and every library's resources, an R class for the app and each library package
  const manifest = join(work, 'AndroidManifest.xml')
  writeFileSync(
    manifest,
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${identifier}" android:versionCode="1" android:versionName="0.0.2">`,
      `  <uses-sdk android:minSdkVersion="${MINIMUM_SDK}" android:targetSdkVersion="${TARGET_SDK}" />`,
      `  <application android:label="${name}" android:theme="@android:style/Theme.Material.Light.NoActionBar">`,
      '    <activity android:name=".TermActivity" android:exported="true" android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden|uiMode|fontScale|density">',
      '      <intent-filter>',
      '        <action android:name="android.intent.action.MAIN" />',
      '        <category android:name="android.intent.category.LAUNCHER" />',
      '      </intent-filter>',
      '    </activity>',
      '  </application>',
      '</manifest>',
      '',
    ].join('\n'),
  )
  const base = join(work, `${name}-base.apk`)
  const generated = join(work, 'gen')

  try {
    run(join(tools.buildTools, 'aapt2'), [
      'link',
      '-o',
      base,
      '-I',
      tools.platform,
      '--manifest',
      manifest,
      '--java',
      generated,
      '--auto-add-overlay',
      ...(packages.size > 0 ? ['--extra-packages', [...packages].join(':')] : []),
      ...flats.flatMap(flat => ['-R', flat]),
    ])
  } catch (e) {
    return { form: 'failed', stage: 'resources', reason: failure(e) }
  }

  // the R classes, compiled
  const rClasses = join(work, 'r')
  const rJar = join(work, 'r.jar')

  try {
    mkdirSync(rClasses, { recursive: true })
    run('javac', ['--release', '17', '-nowarn', '-d', rClasses, ...filesUnder(generated, '.java')])
    run('jar', ['cf', rJar, '-C', rClasses, '.'])
  } catch (e) {
    return { form: 'failed', stage: 'r classes', reason: failure(e) }
  }

  // 4. the program, with the Compose plugin, against android.jar, the libraries and the R classes
  const appJar = join(work, 'app.jar')

  try {
    run('kotlinc', [
      source,
      '-classpath',
      [tools.platform, rJar, ...jars].join(':'),
      `-Xplugin=${plugin}`,
      '-jvm-target',
      '17',
      '-nowarn',
      '-Xno-param-assertions',
      '-Xno-call-assertions',
      '-Xno-receiver-assertions',
      '-d',
      appJar,
    ])
  } catch (e) {
    return { form: 'failed', stage: 'kotlinc', reason: failure(e) }
  }

  // 5. everything dexed: d8 writes classes.dex, classes2.dex, ... as the method count needs
  const dex = join(work, 'dex')

  try {
    mkdirSync(dex, { recursive: true })
    run(join(tools.buildTools, 'd8'), ['--release', '--lib', tools.platform, '--min-api', String(MINIMUM_SDK), '--output', dex, appJar, rJar, ...jars])
  } catch (e) {
    return { form: 'failed', stage: 'd8', reason: failure(e) }
  }

  // 6. the dex files into the base APK, aligned and signed with the debug key, as the cask signs its own
  const aligned = join(work, `${name}-aligned.apk`)
  const apk = join(work, `${name}.apk`)
  const keystore = join(process.env.HOME ?? '', '.android', 'debug.keystore')

  try {
    run('zip', ['-q', '-j', base, ...filesUnder(dex, '.dex')])
    run(join(tools.buildTools, 'zipalign'), ['-f', '-p', '4', base, aligned])

    if (!existsSync(keystore)) {
      mkdirSync(join(keystore, '..'), { recursive: true })
      run('keytool', ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-alias', 'androiddebugkey', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US'])
    }

    run(join(tools.buildTools, 'apksigner'), ['sign', '--ks', keystore, '--ks-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey', '--key-pass', 'pass:android', '--out', apk, aligned])
  } catch (e) {
    return { form: 'failed', stage: 'package', reason: failure(e) }
  }

  return { form: 'built', apk }
}

export type ComposeAndroidRan =
  | { form: 'skipped'; reason: string }
  | { form: 'ran'; installed: boolean; output: string; exited: boolean }

// install the APK on the emulator clean, launch it, read its `native-dom` log until it says it exits (two minutes at
// most), and pull the PNG it wrote under `shot`, a name in its external files directory, to `pulled`
export function runComposeAndroid({
  apk,
  identifier,
  shot,
  pulled,
}: {
  apk: string
  identifier: string
  shot: string
  pulled: string
}): ComposeAndroidRan {
  const found = androidDevice()

  if ('missing' in found) {
    return { form: 'skipped', reason: found.missing }
  }

  const tools = androidTools()
  const adb = (...args: string[]) => spawnSync(tools.adb, ['-s', found.serial, ...args], { encoding: 'utf8' })
  adb('uninstall', identifier)
  adb('logcat', '-c')
  const installed = adb('install', '-r', apk).status === 0
  adb('shell', 'am', 'start', '-n', `${identifier}/.TermActivity`)

  let log = ''
  const deadline = Date.now() + 120_000

  while (Date.now() < deadline) {
    log = adb('logcat', '-d', '-s', 'native-dom:I', 'AndroidRuntime:E').stdout ?? ''

    if (log.includes('native-view exit') || log.includes('FATAL EXCEPTION')) {
      break
    }

    spawnSync('sleep', ['1'])
  }

  const output = log
    .split('\n')
    .map(line => (line.includes('native-dom:') ? line.slice(line.indexOf('native-dom:') + 'native-dom:'.length).trim() : line))
    .join('\n')
  const picture = spawnSync(tools.adb, ['-s', found.serial, 'exec-out', 'cat', `/sdcard/Android/data/${identifier}/files/${shot}`])

  if (picture.status === 0 && picture.stdout.length > 0) {
    writeFileSync(pulled, picture.stdout)
  }

  return { form: 'ran', installed, output, exited: output.includes('native-view exit 0') }
}
