// `term halt`: stop running `term boot` servers.
//   term halt -p <port>   stop the app serving on that port
//   term halt             stop every term boot instance on the machine
//
// Term boot servers are easy to find without a registry: each runs `node <project>/.base/@cluesurf/term/boot/<hash>/run.mjs`, a path
// that is unique to term boot. We match that in the process table (cross-process, machine-wide), so `term halt` works
// from anywhere with no shared state to go stale. `term halt -p <port>` instead asks the OS who is listening on the port.

import { execSync } from 'child_process'
import { closeRun, count, openRun, report } from '@term/call/code/output'

// the marker that identifies a term boot server process in the process table
const BOOT_MARKER = '.base/@cluesurf/term/boot/'

// the PIDs of every running term boot server (match the run.mjs path in each process's command line)
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
  // `term halt -p 2400,2401` stops the apps on those ports; bare `term halt` stops every term boot instance
  // each process stopped is a `stop` lifecycle item (section 9), its pid a fact
  if (input.ports?.length) {
    openRun({ verb: 'halt', root: process.cwd(), facts: input.ports.map(port => `:${port}`) })

    let stopped = 0

    for (const port of input.ports) {
      const pids = pidsOnPort(port)

      if (!pids.length) {
        report({ glyph: 'warning', kind: 'lifecycle', verb: 'stop', subject: `Nothing is serving on :${port}` })

        continue
      }

      for (const pid of pids) {
        if (stop(pid)) {
          stopped++
          report({ glyph: 'done', kind: 'lifecycle', verb: 'stop', subject: `:${port}`, facts: [`pid ${pid}`] })
        }
      }
    }

    closeRun({ verdict: stopped > 0 ? 'Stopped' : 'Nothing stopped', counts: [count(stopped, 'processes', 'process')] })

    return
  }

  openRun({ verb: 'halt', root: process.cwd(), facts: ['every term boot'] })

  const pids = bootPids()
  let stopped = 0

  for (const pid of pids) {
    if (stop(pid)) {
      stopped++
      report({ glyph: 'done', kind: 'lifecycle', verb: 'stop', subject: 'term boot', facts: [`pid ${pid}`] })
    }
  }

  closeRun({
    verdict: pids.length ? 'Stopped' : 'No term boot instance is running',
    counts: [count(stopped, 'instances', 'instance')],
  })
}
