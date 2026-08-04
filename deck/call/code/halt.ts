// `seed halt` — stop running `seed boot` servers.
//   seed halt <port>   stop the app serving on that port
//   seed halt          stop every seed boot instance on the machine
//
// Seed boot servers are easy to find without a registry: each runs `node <project>/.base/term/boot/<hash>/run.mjs`, a path
// that is unique to seed boot. We match that in the process table (cross-process, machine-wide), so `seed halt` works
// from anywhere with no shared state to go stale. `seed halt <port>` instead asks the OS who is listening on the port.

import { execSync } from 'child_process'
import {
  logStep,
  logGood,
  logFail,
  fade,
} from '@term/make/code/tint'

// the marker that identifies a seed boot server process in the process table
const BOOT_MARKER = '.base/term/boot/'

// the PIDs of every running seed boot server (match the run.mjs path in each process's command line)
function bootPids(): number[] {
  try {
    const out = execSync('ps -ax -o pid=,command=', {
      encoding: 'utf8',
    })

    return out
      .split('\n')
      .filter(
        line => line.includes(BOOT_MARKER) && line.includes('run.mjs'),
      )
      .map(line => Number(line.trim().split(/\s+/)[0]))
      .filter(pid => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

// the PIDs listening on a TCP port
function pidsOnPort(port: number): number[] {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: 'utf8',
    })

    return out
      .split('\n')
      .map(line => Number(line.trim()))
      .filter(pid => Number.isInteger(pid) && pid > 0)
  } catch {
    // lsof exits non-zero when nothing is listening
    return []
  }
}

// SIGTERM a pid, falling back to nothing if it is already gone
function stop(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')

    return true
  } catch {
    return false
  }
}

export async function callHalt(input: {
  ports?: number[]
}): Promise<void> {
  // `seed halt -p 2400,2401` stops the apps on those ports; bare `seed halt` stops every seed boot instance
  if (input.ports?.length) {
    logStep(`Halting app(s) on port ${input.ports.join(', ')}...`)

    let stopped = 0

    for (const port of input.ports) {
      const pids = pidsOnPort(port)

      if (!pids.length) {
        logFail(`Nothing is serving on port ${port}`)

        continue
      }

      for (const pid of pids) {
        if (stop(pid)) {
          stopped++
          console.log(fade(`  stopped pid ${pid} (port ${port})`))
        }
      }
    }

    logGood(`Stopped ${stopped} process(es)`)

    return
  }

  logStep('Halting all seed boot instances...')

  const pids = bootPids()

  if (!pids.length) {
    logGood('No seed boot instances running')

    return
  }

  let stopped = 0

  for (const pid of pids) {
    if (stop(pid)) {
      stopped++
      console.log(fade(`  stopped pid ${pid}`))
    }
  }

  logGood(`Stopped ${stopped} seed boot instance(s)`)
}
