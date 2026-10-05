// `term work --target compose|compose-android` (live-reload): a Compose app rebuilt and relaunched on every `.tree` edit,
// opening on the screen it was on, with the same screens behind it for back.
//
// A native build is compiled ahead of time and carries no interpreter, so a change to a view is a new program: the loop
// builds it while the running app stays up, and only a build that succeeds replaces it. The app's NAVIGATION HISTORY
// crosses the relaunch through a dev address (deck/site/code/view/native/toolkit/address.tree): the navigation contract
// writes its history there on every move, and the next run starts from it. The web needs none of this: `term feed`
// swaps a module inside the running page and keeps its signals (deck/make/code/dev/client.ts).
//
//   compose          kotlinc into a jar, run on this machine's JVM with TERM_DEV_ADDRESS set
//   compose-android  an APK, installed over the running one and started with the address as an Intent extra
//
// The loop is `startComposeWork`, which a test drives directly; `workCompose` is the command around it.

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, watch } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { androidDevice, androidTools, launchOnAndroid } from '@term/call/code/cask'
import { buildCompose, buildComposeAndroid, composeIdentity } from '@term/call/code/compose'
import type { Stages } from '@term/call/code/compose'
import { startKotlinWorker } from '@term/call/code/kotlin-worker'
import { CompileCache } from '@term/make/code/compile/cache'
import { makeParseMemo } from '@term/make/code/compile/load'
import { closeRun, followChild, openRun, report } from '@term/call/code/output'

export type ComposeTarget = 'compose' | 'compose-android'

// what the loop did, in order. A `launch` carries the child whose standard output is the app's own lines: the JVM on the
// desktop, `adb logcat` of the app's process on Android. A `failed` names its stage: a build stage (`compile`, `build`,
// ...), a toolchain this machine lacks (`skipped`), or `launch`
export type WorkEvent =
  | { kind: 'built'; generation: number; duration: number; stages: Stages }
  | { kind: 'failed'; generation: number; stage: string; reason: string }
  | { kind: 'launch'; generation: number; child: ChildProcess }
  | { kind: 'exit'; generation: number }

export type ComposeWork = {
  // resolves once no build is running or waiting: what a test waits on after an edit
  idle(): Promise<void>
  // the running app stopped, the watcher closed
  stop(): Promise<void>
}

// the app as the loop holds it while it runs
type Running = { stop(): Promise<void> }

// the file the desktop's history is written to, and the name of the one in an Android app's external files directory
const ADDRESS = 'dev-address'

// a burst of saves (an editor writing a file twice, a formatter after it) is one change
const SETTLE_MS = 80

export function startComposeWork(input: {
  root: string
  target: ComposeTarget
  entry?: string
  // added to the desktop app's environment (a test runs it headless with TERM_WINDOW_AWAY=1)
  env?: Record<string, string>
  onEvent: (event: WorkEvent) => void
}): ComposeWork {
  const root = resolve(input.root)
  const entry = join(root, input.entry ?? 'app.tree')
  const out = join(root, 'host', input.target)
  const { identifier } = composeIdentity(root)
  const address = join(out, ADDRESS)
  mkdirSync(out, { recursive: true })
  // what the session keeps warm between builds: one Kotlin compiler, so a rebuild pays for the code and not for
  // starting a JVM, and the Term compiler's parsed modules, so an edit reparses only the files that changed
  const kotlin = startKotlinWorker(join(out, 'kotlin'))
  const cache = new CompileCache()
  // and the parses the scope check walks (deck/call/code/scope.ts), which an edit to the scope itself rechecks
  const memo = makeParseMemo()

  // a session starts at the app's first screen: the history of an earlier session is not this one's
  forgetAddress(input.target, address, identifier)

  let generation = 0
  let running: Running | undefined
  let building: Promise<void> | undefined
  let dirty = false
  // a change waiting out its settle: work not started yet, which `idle` waits for too
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduled = false
  let stopped = false

  // one build at a time; a change during it is built right after, once, however many changes came
  const rebuild = (): Promise<void> => {
    if (building) {
      dirty = true

      return building
    }

    building = (async () => {
      do {
        dirty = false
        try {
          await buildAndLaunch()
        } catch (error) {
          // a launch that could not happen (no device online, a JVM that would not start) is reported and the loop
          // goes on: the next edit tries again
          input.onEvent({ kind: 'failed', generation, stage: 'launch', reason: error instanceof Error ? error.message : String(error) })
        }
      } while (dirty && !stopped)
      building = undefined
    })()

    return building
  }

  const buildAndLaunch = async (): Promise<void> => {
    generation += 1
    const current = generation
    // two folders in turn: the build never writes over the jar the running app was loaded from
    const dir = join(out, 'work', String(current % 2))
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const started = Date.now()
    const text = existsSync(entry) ? readFileSync(entry, 'utf8') : ''
    const warm = { file: entry, compiler: kotlin.compile, cache, scope: { root, memo } }
    const built =
      input.target === 'compose'
        ? buildCompose({ root, dir, name: 'app', text, ...warm })
        : buildComposeAndroid({ root, dir, name: 'app', text, identifier, ...warm })
    const duration = Date.now() - started

    if (built.form !== 'built') {
      // the running app is kept: an edit that does not build changes nothing a person can see but the report
      const stage = built.form === 'skipped' ? 'skipped' : built.stage
      input.onEvent({ kind: 'failed', generation: current, stage, reason: built.reason })

      return
    }

    input.onEvent({ kind: 'built', generation: current, duration, stages: built.stages })

    if (stopped) {
      return
    }

    await running?.stop()
    const onExit = () => input.onEvent({ kind: 'exit', generation: current })
    const launched =
      'jar' in built
        ? launchDesktop({ root, jar: built.jar, classpath: built.classpath, main: built.main, address, env: input.env ?? {}, onExit })
        : await launchAndroid({ apk: built.apk, identifier, onExit })
    running = launched.running
    input.onEvent({ kind: 'launch', generation: current, child: launched.child })
  }

  // the source files: every `.tree` under the root, never the build's own output
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    const file = typeof name === 'string' ? name : ''
    const inside = relative(root, join(root, file))

    if (!file.endsWith('.tree') || inside.startsWith('host/') || inside.startsWith('node_modules/')) {
      return
    }

    clearTimeout(timer)
    scheduled = true
    timer = setTimeout(() => {
      scheduled = false
      void rebuild()
    }, SETTLE_MS)
  })

  void rebuild()

  return {
    idle: async () => {
      while (scheduled || building) {
        await (building ?? new Promise(done => setTimeout(done, SETTLE_MS)))
      }
    },
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      scheduled = false
      watcher.close()
      await building
      await running?.stop()
      kotlin.close()
    },
  }
}

// the history of an earlier session thrown away: the desktop's file, or the one in the Android app's files
function forgetAddress(target: ComposeTarget, address: string, identifier: string): void {
  if (target === 'compose') {
    rmSync(address, { force: true })

    return
  }

  const found = androidDevice()

  if ('serial' in found) {
    spawnSync(androidTools().adb, ['-s', found.serial, 'shell', 'rm', '-f', `/sdcard/Android/data/${identifier}/files/${ADDRESS}`])
  }
}

// the app on this machine's JVM, its history at `address`, started IN the app's folder (`root`, named by path): a JVM
// cannot start in a folder that no longer exists, and inheriting the loop's own let a folder deleted under the loop
// stop every relaunch after it. It is also the desktop's bundle path (`bundlePath`, the folder the app started from).
// Stopping asks it to end and, after three seconds, makes it
function launchDesktop(input: {
  root: string
  jar: string
  classpath: string
  main: string
  address: string
  env: Record<string, string>
  onExit: () => void
}): { running: Running; child: ChildProcess } {
  const child = spawn('java', ['--enable-native-access=ALL-UNNAMED', '-classpath', `${input.jar}:${input.classpath}`, input.main], {
    cwd: input.root,
    env: { ...process.env, ...input.env, TERM_DEV_ADDRESS: input.address },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ended = new Promise<void>(done => child.once('exit', () => done()))
  void ended.then(input.onExit)

  return {
    child,
    running: {
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return
        }

        child.kill('SIGTERM')
        const late = setTimeout(() => child.kill('SIGKILL'), 3000)
        await ended
        clearTimeout(late)
      },
    },
  }
}

// the app installed over the running one and started with its address; its lines are its own process's `native-dom`
// log, read while it runs. It has ended when its process is gone
async function launchAndroid(input: { apk: string; identifier: string; onExit: () => void }): Promise<{ running: Running; child: ChildProcess }> {
  const found = androidDevice()

  if ('missing' in found) {
    throw new Error(found.missing)
  }

  const adb = androidTools().adb
  const pidOf = (): string => (spawnSync(adb, ['-s', found.serial, 'shell', 'pidof', input.identifier], { encoding: 'utf8' }).stdout ?? '').trim().split(/\s+/)[0] ?? ''
  launchOnAndroid({ serial: found.serial, apk: input.apk, identifier: input.identifier, extras: { TERM_DEV_ADDRESS: ADDRESS } })

  // the process the Activity starts in, looked for over five seconds
  let pid = ''
  for (let tries = 0; tries < 50 && !pid; tries++) {
    pid = pidOf()
    if (!pid) await new Promise(done => setTimeout(done, 100))
  }

  const child = spawn(adb, ['-s', found.serial, 'logcat', '-v', 'raw', `--pid=${pid}`, '-s', 'native-dom:I'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let ended = false
  const poll = setInterval(() => {
    if (pidOf() !== pid) {
      clearInterval(poll)
      ended = true
      child.kill()
      input.onExit()
    }
  }, 500)

  return {
    child,
    running: {
      stop: async () => {
        clearInterval(poll)
        child.kill()

        if (!ended) {
          spawnSync(adb, ['-s', found.serial, 'shell', 'am', 'force-stop', input.identifier])
          ended = true
          input.onExit()
        }
      },
    },
  }
}

// `term work --target compose|compose-android`: the loop, each build and launch an item, the app's lines followed
// under its name, until Ctrl-C
export async function workCompose(input: { root: string; target: ComposeTarget; entry?: string }): Promise<void> {
  const root = resolve(input.root)
  const { name } = composeIdentity(root)
  openRun({ verb: 'work', root, facts: [`--target ${input.target}`] })
  report({
    glyph: 'info',
    kind: 'lifecycle',
    verb: 'start',
    subject: name,
    message: ['Edit a .tree file and the app is rebuilt and relaunched on the screen it was on. Ctrl-C stops.'],
  })

  const work = startComposeWork({
    root,
    target: input.target,
    entry: input.entry,
    onEvent: event => {
      if (event.kind === 'built') {
        // where the time went, stage by stage: what a person waiting on a rebuild wants to know
        report({ glyph: 'done', verb: 'build', subject: input.target, duration: event.duration, facts: event.stages.map(([stage, ms]) => `${stage} ${(ms / 1000).toFixed(1)}s`) })
      } else if (event.kind === 'failed') {
        report({ glyph: 'failed', verb: event.stage === 'launch' ? 'start' : 'build', subject: input.target, message: [event.reason, 'The running app is kept.'] })
      } else if (event.kind === 'launch') {
        report({ glyph: 'info', kind: 'lifecycle', verb: 'start', subject: `${name} #${event.generation}` })
        followChild(event.child, name)
      }
    },
  })

  await new Promise<void>(done => process.once('SIGINT', () => done()))
  await work.stop()
  process.exit(closeRun({ verdict: 'Stopped', failure: 'interrupted', uptime: true }))
}
