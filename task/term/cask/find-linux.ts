// The Linux desktop `term find` is tried against, built and run on the work droplet, never on this machine: the image
// make/Dockerfile.find-linux (AT-SPI, a session bus, a window manager) in an X11 session (Xvfb and openbox) or a
// Wayland one (sway, headless). One command runs inside the session and its output and exit status come back.
//
//   pnpm term:find-linux --session x11 -- <command> [args]
//   pnpm term:find-linux --session wayland -- <command> [args]
//   pnpm term:find-linux --session x11 --proof     the spike's proof: gnome-text-editor's frame and a push button, walked over Atspi
//
//   --no-build   skip shipping and building: the image is already on the droplet
//   --timeout S  seconds the command may run (default 120)
//
// As rust-remote.ts does it: droplet.ts `ship` and `remote`, the image built there. Exit status is the command's, 70
// when the droplet could not build or reach it.
import { join } from 'node:path'
import { REMOTE_ROOT, remote, ship } from './droplet'
import { TERM_ROOT } from '../root'

const IMAGE = 'term-find-linux'

// the make directory beside this task's package, as every term task runs from the Term root
const MAKE = join(TERM_ROOT, 'make')

export type FindLinuxSession = 'x11' | 'wayland'

// single-quote one word for the droplet's shell
function quote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

export function buildFindLinux(log: (line: string) => void = line => console.log(`find-linux  ${line}`)): void {
  const root = `${REMOTE_ROOT}/find-linux`
  const docker = remote('docker --version', { timeout: 60_000 })

  if (!docker.stdout.includes('Docker')) {
    throw new Error(`the work droplet has no docker for ssh sessions:\n${docker.stdout}${docker.stderr}`)
  }

  log('shipping the image recipe to the work droplet')
  ship(MAKE, `${root}/make`)
  log('building the image there (the first time downloads the desktop packages, minutes)')
  const built = remote(`cd ${root}/make && docker build -q -f Dockerfile.find-linux -t ${IMAGE} . 2>&1`, { timeout: 1_800_000 })

  if (built.status !== 0) {
    throw new Error(`the image build failed:\n${built.stdout.split('\n').slice(-30).join('\n')}${built.stderr}`)
  }
}

// run `command` in a session of the image. `output` is everything the session and the command said
export function runInFindLinux(input: { session: FindLinuxSession; command: string[]; timeout?: number }): { status: number; output: string } {
  const seconds = input.timeout ?? 120
  const words = input.command.map(quote).join(' ')
  const ran = remote(`docker run --rm ${IMAGE} ${input.session} timeout ${seconds} ${words} 2>&1`, { timeout: (seconds + 120) * 1000 })

  return { status: ran.status, output: `${ran.stdout}${ran.stderr}` }
}

// the spike's proof: the editor started, given time to come up, then walked over Atspi
const PROOF = ['sh', '-c', 'gnome-text-editor >/tmp/editor.log 2>&1 & sleep 8; python3 -I /usr/local/bin/find-linux-walk gnome-text-editor']

if (process.argv[1]?.endsWith('find-linux.ts')) {
  const args = process.argv.slice(2)
  const flag = (name: string) => args.indexOf(name)
  const sessionAt = flag('--session')
  const session = sessionAt >= 0 ? args[sessionAt + 1] : ''
  const timeoutAt = flag('--timeout')
  const dash = args.indexOf('--')
  const command = flag('--proof') >= 0 ? PROOF : dash >= 0 ? args.slice(dash + 1) : []

  if ((session !== 'x11' && session !== 'wayland') || command.length === 0) {
    console.error('usage: pnpm term:find-linux --session <x11|wayland> (--proof | -- <command> [args]) [--no-build] [--timeout S]')
    process.exit(64)
  }

  try {
    if (flag('--no-build') < 0) {
      buildFindLinux()
    }

    const done = runInFindLinux({ session, command, timeout: timeoutAt >= 0 ? Number(args[timeoutAt + 1]) : undefined })
    process.stdout.write(done.output.endsWith('\n') ? done.output : `${done.output}\n`)
    process.exit(done.status)
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(70)
  }
}
