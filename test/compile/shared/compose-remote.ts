// Compose on ANOTHER desktop (compose-target-0004, 0005): a Term program's Compose app image packaged by THAT
// platform's jpackage and run there. jpackage builds only for the OS it runs on, but only Skia's native library differs
// between desktops: the program's jar and its runtime are the same bytecode everywhere. So the program is built here,
// the target's Compose libraries are resolved here (`compose-desktop-files <os>-<arch>`, task/term/native/kotlin.sh),
// and the input folder goes to the target, which packages it with its own jpackage, runs the image headless
// (TERM_WINDOW_AWAY=1, Skia drawing offscreen), and hands back what the app said and the PNG it wrote.
//
//   linux    the work droplet (x86_64), inside the image make/Dockerfile.compose-linux (a JDK and fonts), through
//            task/term/cask/droplet.ts, as the Linux cask is built
//   windows  the Windows machine WINDOWS_VM names, through task/term/cask/windows.ts, as the Windows cask is built:
//            the local Windows 11 ARM64 guest, or an x64 EC2 machine rented for the session
//            (task/term/cask/ec2-windows.ts). The machine is ASKED what it is: its architecture picks the Compose
//            artifact, and its JDK is the jpackage on its PATH (where the EC2 machine's startup puts one), else the
//            one in the user's profile (`term-jdk`, the local guest)
//
// The same input folder and the same jpackage arguments as an image made on this machine (deck/call/code/compose.ts
// `composeInput`, `jpackageArguments`). A helper, not a suite: shared/ is not walked by the runner.

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { buildCompose, composeInput, jpackageArguments } from '@term/call/code/compose'
// as their default: the task/ scripts are CommonJS, whose exports Node cannot name ahead of loading them, so a named or
// namespace import of one finds them only on `default`
import droplet from '../../../../../../../task/term/cask/droplet'
import windows from '../../../../../../../task/term/cask/windows'

export type RemoteDesktop = 'linux' | 'windows'

// where the local Windows guest keeps its JDK, in the user's profile: the folder a JDK's zip unpacks to, under `term-jdk`
const WINDOWS_JDK = 'term-jdk'

// a Windows machine's PROCESSOR_ARCHITECTURE, as the Compose artifact built for it
const WINDOWS_TARGET: Record<string, string> = { AMD64: 'windows-x64', ARM64: 'windows-arm64' }

export type RemoteRan =
  | { form: 'skipped'; reason: string }
  | { form: 'failed'; stage: string; reason: string }
  | { form: 'ran'; output: string; picture: boolean }

// the target, reached: its Compose artifact and the jpackage it packages with, or why it cannot be used
type Reached = { form: 'reached'; target: string; jpackage: string } | { form: 'unreachable'; reason: string }

function reach(desktop: RemoteDesktop): Reached {
  const unreachable = (text: string): Reached => ({ form: 'unreachable', reason: `${desktop}: ${text.trim().slice(0, 300) || 'no answer'}` })

  try {
    // the droplet is x86_64, and its jpackage is the Docker image's
    if (desktop === 'linux') {
      const ran = droplet.remote('docker --version', { timeout: 60_000 })

      return ran.status === 0 && ran.stdout.trim() ? { form: 'reached', target: 'linux-x64', jpackage: 'jpackage' } : unreachable(ran.stderr || ran.stdout)
    }

    // three answers in one round trip: the architecture, a jpackage on the PATH, then any in the profile
    const ran = windows.remote(`echo %PROCESSOR_ARCHITECTURE%& where jpackage.exe 2>nul& for /d %j in (%USERPROFILE%\\${WINDOWS_JDK}\\*) do @echo %j\\bin\\jpackage.exe`, { timeout: 60_000 })
    const lines = ran.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const target = WINDOWS_TARGET[lines[0] ?? '']
    const jpackage = lines.slice(1).find(line => /jpackage\.exe$/i.test(line))

    if (ran.status !== 0 || !target) {
      return unreachable(ran.stderr || ran.stdout)
    }

    return jpackage ? { form: 'reached', target, jpackage } : unreachable(`no JDK: no jpackage.exe on the PATH or under %USERPROFILE%\\${WINDOWS_JDK}`)
  } catch (e) {
    return unreachable((e as Error).message)
  }
}

// build `text` here, package it on `desktop` and run it there. `name` is the app image's name, `shot` the file name the
// program writes its PNG to (in the folder it runs in), `pulled` where that PNG comes back to
export function runComposeRemote(input: {
  root: string
  dir: string
  name: string
  text: string
  desktop: RemoteDesktop
  shot: string
  pulled: string
}): RemoteRan {
  const reached = reach(input.desktop)

  if (reached.form === 'unreachable') {
    return { form: 'skipped', reason: reached.reason }
  }

  const built = buildCompose({ root: input.root, dir: input.dir, name: `compose-${input.desktop}`, text: input.text })

  if (built.form !== 'built') {
    return built.form === 'skipped' ? built : { form: 'failed', stage: built.stage, reason: built.reason }
  }

  // the target's libraries beside the program's own runtime, which is the same bytecode on every desktop
  const libraries = execFileSync('bash', [join(input.root, '../../../../task/term/native/kotlin.sh'), 'compose-desktop-files', reached.target], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  const folder = join(input.dir, `input-${input.desktop}`)
  composeInput({ jar: built.jar, libraries: [...built.runtimeJars, ...libraries], input: folder })

  const remoteRoot = `term-compose/${input.name}`

  if (input.desktop === 'linux') {
    droplet.ship(folder, `${remoteRoot}/input`)
    droplet.ship(join(input.root, 'make'), `${remoteRoot}/make`)
    const imaged = droplet.remote(`cd ${remoteRoot}/make && docker build -q -f Dockerfile.compose-linux -t term-compose-linux . 2>&1`, { timeout: 1_800_000 })

    if (imaged.status !== 0) {
      return { form: 'failed', stage: 'image', reason: `${imaged.stdout}${imaged.stderr}`.slice(-1600) }
    }

    const args = jpackageArguments({ input: '/work/input', jar: built.jar, main: built.main, name: input.name, dest: '/work/out' }).join(' ')
    const ran = droplet.remote(
      `docker run --rm -v $HOME/${remoteRoot}:/work term-compose-linux sh -c "rm -rf /work/out /work/run && mkdir -p /work/run && jpackage ${args} && cd /work/run && TERM_WINDOW_AWAY=1 timeout 300 /work/out/${input.name}/bin/${input.name}" 2>&1`,
      { timeout: 900_000 },
    )

    return { form: 'ran', output: `${ran.stdout}${ran.stderr}`, picture: droplet.fetch(`${remoteRoot}/run/${input.shot}`, input.pulled) }
  }

  windows.ship(folder, `${remoteRoot.replace(/\//g, '\\')}\\input`)
  const root = remoteRoot.replace(/\//g, '\\')
  const args = jpackageArguments({ input: 'input', jar: built.jar, main: built.main, name: input.name, dest: 'out', console: true }).join(' ')
  const ran = windows.remote(
    `cd /d %USERPROFILE%\\${root} && (if exist out rmdir /s /q out) & (if exist run rmdir /s /q run) & mkdir run && "${reached.jpackage}" ${args} && cd run && set TERM_WINDOW_AWAY=1&& ..\\out\\${input.name}\\${input.name}.exe 2>&1`,
    { timeout: 900_000 },
  )

  return { form: 'ran', output: `${ran.stdout}${ran.stderr}`, picture: windows.fetch(`${remoteRoot}/run/${input.shot}`, input.pulled) }
}
