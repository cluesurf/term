// Running a Term program built for Compose on the desktop JVM (compose-target). The build itself is the CLI's,
// `buildCompose` in deck/call/code/compose.ts (what `term make --target compose` runs before packaging), so a test and
// an app build go through the same code. This runs the built jar headless (TERM_WINDOW_AWAY=1: the runtime hosts the
// tree in Compose's desktop test host) and answers what it printed. A helper, not a suite: shared/ is not walked by the
// runner. Used by test/compile/compose-view.ts and the `compose` leg of ./toolkit-run.ts.

import { spawnSync } from 'node:child_process'

export type ComposeRan = { status: number | null; output: string; error: string }

// run a built program headless, answering what it printed
export function runCompose(built: { jar: string; classpath: string; main: string }): ComposeRan {
  const ran = spawnSync(
    'java',
    ['-Djava.awt.headless=true', '--enable-native-access=ALL-UNNAMED', '-classpath', `${built.jar}:${built.classpath}`, built.main],
    { encoding: 'utf8', env: { ...process.env, TERM_WINDOW_AWAY: '1' }, timeout: 180_000 },
  )

  return { status: ran.status, output: String(ran.stdout), error: String(ran.stderr) }
}
