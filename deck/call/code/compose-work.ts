// `term work --target compose|compose-android` (live-reload): a Compose app rebuilt and relaunched on every `.tree` edit,
// opening on the screen it was on, with the same screens behind it for back.
//
// A FACE OVER THE PORT, work/compose/reload-loop.tree (term-cli-in-term-0036), which the CLI runs: since item
// term-self-host-001-0414 (decision 099) the loop builds through one build graph over the machine store, and this file
// no longer carries a second loop with its own cache. Its callers (test/compile/compose-work.ts) keep this API.
//
//   compose          kotlinc into a jar, run on this machine's JVM with TERM_DEV_ADDRESS set
//   compose-android  an APK, installed over the running one and started with the address as an Intent extra

import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Stages } from '@term/call/code/compose'

// the port, loaded as the module system finds it and not as a typed import: the emitted reload-loop.ts holds 17 typing
// errors of its own (deck/call/host/port/code/work/compose/reload-loop.ts, latent before 0414: no typed import reached
// it), which a typed import would add to node-switch's count. The shape it is called with is written here
const emitted = createRequire(import.meta.url)('@term/call/code/work/compose/reload-loop') as { default?: unknown }
// the emitted port may load as CommonJS, its exports under `default`
const loop = (emitted.default ?? emitted) as {
  startComposeWork: (ask: unknown) => { idle: () => Promise<void>; stop: () => Promise<void> }
  workCompose: (ask: unknown) => Promise<void>
}

export type ComposeTarget = 'compose' | 'compose-android'

// what the loop did, in order. A `launch` carries the child whose standard output is the app's own lines: the JVM on the
// desktop, `adb logcat` of the app's process on Android. A `failed` names its stage: a build stage (`compile`, `build`,
// ...), a toolchain this machine lacks (`skipped`), or `launch`
export type WorkEvent =
  | {
      kind: 'built'
      generation: number
      duration: number
      stages: Stages
    }
  | {
      kind: 'failed'
      generation: number
      stage: string
      reason: string
    }
  | { kind: 'launch'; generation: number; child: ChildProcess }
  | { kind: 'exit'; generation: number }

export type ComposeWork = {
  // resolves once no build is running or waiting: what a test waits on after an edit
  idle(): Promise<void>
  // the running app stopped, the watcher closed
  stop(): Promise<void>
}

// the loop started: the app built and launched at once, and again on every `.tree` edit under its root
export function startComposeWork(input: {
  root: string
  target: ComposeTarget
  entry?: string
  // added to the desktop app's environment (a test runs it headless with TERM_WINDOW_AWAY=1)
  env?: Record<string, string>
  onEvent: (event: WorkEvent) => void
}): ComposeWork {
  const face = loop.startComposeWork({
    root: input.root,
    target: input.target,
    entry: input.entry,
    env: input.env,
    onEvent: input.onEvent,
  })

  return { idle: () => face.idle(), stop: () => face.stop() }
}

// `term work --target compose|compose-android`: the loop, each build and launch an item, until Ctrl-C
export function workCompose(input: {
  root: string
  target: ComposeTarget
  entry?: string
}): Promise<void> {
  return loop.workCompose({
    root: input.root,
    target: input.target,
    entry: input.entry,
    onEvent: () => undefined,
  })
}
