// The work droplet as the Linux box a cask is built and run on. This laptop writes the cargo project and the app
// directory; the droplet, which has Rust, GTK4, WebKitGTK and Xvfb, builds the executable and runs it with no
// display. Used by task/term/app-smoke.ts for `--target linux`.
//
// The droplet's address comes from tofu, its variables from zone as land/makefile reads them, or WORK_DROPLET_IP, and
// is never printed: every line this file prints has addresses redacted. The key is the one every droplet
// authorises, ~/.ssh/cs-work-droplet-deploy (DROPLET_KEY overrides), with IdentitiesOnly so nothing else is offered.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parentRoot, zoneCommand } from '../root'

const KEY = process.env.DROPLET_KEY ?? join(process.env.HOME ?? '', '.ssh/cs-work-droplet-deploy')

// the repository root from the Term root, where every term task runs
const LAND = (): string => resolve(parentRoot(), 'land')

// where the droplet keeps what this sends it
export const REMOTE_ROOT = '$HOME/term-cask'

// an address is never shown: a log line is read by more people than the one who ran it. Only the droplet's own, since
// what `remote` answers is data a caller acts on, and a rule hiding every dotted quad also rewrites a four-part
// version number (windows.ts `redact`, where it broke a path)
export function redact(text: string): string {
  const address = (host ?? '').split('@').pop() || process.env.WORK_DROPLET_IP || ''

  return address ? text.split(address).join('<ip>') : text
}

let host: string | undefined

// `root@<address>`, resolved once
export function dropletHost(): string {
  if (host) {
    return host
  }

  const override = process.env.WORK_DROPLET_IP

  if (override) {
    host = `root@${override}`

    return host
  }

  if (!existsSync(LAND())) {
    throw new Error('the land directory is not here, so the work droplet cannot be resolved. Set WORK_DROPLET_IP')
  }

  // tofu's variables from zone, as land/makefile's default reads them: no `.env.tf` file is read
  // (note/project/zone/how-it-works.md). Through land/task/tofu.sh, which hands the R2 state backend its key.
  const found = spawnSync(zoneCommand(), ['load', 'cluesurf/land/tf', '--', 'sh', 'task/tofu.sh', 'output', '-json', 'work_droplet_ips'], {
    cwd: LAND(),
    encoding: 'utf8',
  })
  const address = (() => {
    try {
      return String((JSON.parse(found.stdout ?? '') as string[])[0] ?? '')
    } catch {
      return ''
    }
  })()

  if (!address) {
    throw new Error('could not resolve the work droplet from tofu. Set WORK_DROPLET_IP')
  }

  host = `root@${address}`

  return host
}

export function sshOptions(): string[] {
  if (!existsSync(KEY)) {
    throw new Error(`the droplet key is not at ${KEY}. Set DROPLET_KEY`)
  }

  return ['-i', KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new']
}

// run one command on the droplet. Cargo is on the path, as rustup installs it
export function remote(command: string, { timeout = 600_000 }: { timeout?: number } = {}): { status: number; stdout: string; stderr: string } {
  const ran = spawnSync('ssh', [...sshOptions(), dropletHost(), `export PATH=$HOME/.cargo/bin:$PATH; ${command}`], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  })

  return { status: ran.status ?? -1, stdout: redact(ran.stdout ?? ''), stderr: redact(ran.stderr ?? '') }
}

// a directory to the droplet, whole, as a tar stream over ssh. rsync cannot reach the droplets' host family
// (note/project/land/nas-access.md), and tar is enough for a project directory
export function ship(local: string, remoteDir: string): void {
  const archive = execFileSync('tar', ['-C', local, '-czf', '-', '.'], { maxBuffer: 512 * 1024 * 1024 })
  const sent = spawnSync('ssh', [...sshOptions(), dropletHost(), `mkdir -p ${remoteDir} && tar -C ${remoteDir} -xzf -`], {
    input: archive,
    encoding: 'utf8',
    timeout: 600_000,
  })

  if (sent.status !== 0) {
    throw new Error(`shipping ${local} to the droplet failed: ${redact(sent.stderr ?? '')}`)
  }
}

// one file back from the droplet to `local`, true when it came. `remotePath` is relative to the home directory. By
// scp, as the Windows guest's is, so a file comes back as its bytes
export function fetch(remotePath: string, local: string): boolean {
  return spawnSync('scp', [...sshOptions(), `${dropletHost()}:${remotePath}`, local], { timeout: 120_000 }).status === 0
}

// `pnpm term:cask-droplet --check`: what the droplet has of the toolchain a Linux cask build needs
if (process.argv.includes('--check')) {
  const ran = remote(
    [
      'echo "cargo: $(cargo --version 2>/dev/null || echo missing)"',
      'echo "gtk4: $(pkg-config --modversion gtk4 2>/dev/null || echo missing)"',
      'echo "webkitgtk-6.0: $(pkg-config --modversion webkitgtk-6.0 2>/dev/null || echo missing)"',
      'echo "xvfb-run: $(which xvfb-run 2>/dev/null || echo missing)"',
      'echo "cores: $(nproc)"',
      'echo "memory: $(free -g | awk \'/Mem:/ { print $2 }\') GB"',
      'echo "disk free: $(df -h /root | awk \'NR == 2 { print $4 }\')"',
    ].join('; '),
    { timeout: 60_000 },
  )
  console.log(ran.stdout.trim() || ran.stderr.trim())
  process.exit(ran.status === 0 ? 0 : 1)
}
