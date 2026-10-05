// `term halt`: stop running `term boot` servers.
//   term halt -p <port>   stop the app serving on that port
//   term halt             stop this project's term boot, feed and work, or every one on the machine outside a project
//
// Term boot servers are easy to find without a registry: each runs `node <project>/.base/@cluesurf/term/boot/<hash>/run.mjs`, a path
// that is unique to term boot. We match that in the process table (cross-process, machine-wide), so `term halt` works
// from anywhere with no shared state to go stale. `term halt -p <port>` instead asks the OS who is listening on the port.

import { execSync } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import path from 'path'
import { closeRun, count, openRun, report } from '@term/call/code/output'

// the marker that identifies a term boot server process in the process table
const BOOT_MARKER = '.base/@cluesurf/term/boot/'

type Process = { pid: number; parent: number; command: string }

function processTable(): Process[] {
  try {
    return execSync('ps -ax -o pid=,ppid=,command=', { encoding: 'utf8' })
      .split('\n')
      .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }))
  } catch {
    return []
  }
}

// every running term boot program, the project it belongs to, and the process to stop for it: the `term boot` that
// started it when that is its parent, so the boot shuts it down and ends with its own closing item. Stopping the
// program alone left the boot watching with nothing to serve (guides: commands/halt, 2026-10-04)
function boots(): { program: number; target: number; project: string }[] {
  const table = processTable()
  const byPid = new Map(table.map(one => [one.pid, one]))

  return table
    .filter(one => one.command.includes(BOOT_MARKER) && one.command.includes('run.mjs'))
    .map(one => {
      const at = one.command.indexOf(BOOT_MARKER)
      const start = one.command.lastIndexOf(' ', at) + 1
      const parent = byPid.get(one.parent)
      const owned = parent !== undefined && /\bboot\b/.test(parent.command) && !parent.command.includes('run.mjs')

      return { program: one.pid, target: owned ? parent.pid : one.pid, project: one.command.slice(start, at).replace(/\/$/, '') }
    })
}

// every running `term feed` and `term work`, the verb, and the project its working folder is in. They run no
// `run.mjs`, so bare `halt` did not see them, and only `-p` stopped one (guides: commands/halt, commands/feed,
// 2026-10-05). A service's project is where it was started, which the process table does not say and `lsof` does
function services(): { pid: number; verb: string; project: string | undefined }[] {
  return processTable()
    .map(one => ({ one, verb: /(?:line\.js|need\.mjs|\bterm)\s+(feed|work)(?:\s|$)/.exec(one.command)?.[1] }))
    .filter((found): found is { one: Process; verb: string } => found.verb !== undefined && found.one.pid !== process.pid)
    .map(({ one, verb }) => ({ pid: one.pid, verb, project: projectOfCwd(one.pid) }))
}

// the project holding a process's working folder, or undefined where `lsof` cannot say
function projectOfCwd(pid: number): string | undefined {
  try {
    const out = execSync(`lsof -a -p ${pid} -d cwd -Fn`, { encoding: 'utf8' })
    const cwd = out.split('\n').find(line => line.startsWith('n'))?.slice(1)

    return cwd ? projectOf(cwd) : undefined
  } catch {
    return undefined
  }
}

// the folder holding the nearest deck.tree, from `from` up, or undefined outside a project
function projectOf(from: string): string | undefined {
  let at = path.resolve(from)

  while (true) {
    if (existsSync(path.join(at, 'deck.tree'))) {
      return at
    }

    const up = path.dirname(at)

    if (up === at) {
      return undefined
    }

    at = up
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
    // a program a `term boot` started is stopped through its boot, as bare `halt` does
    const owner = new Map(boots().map(one => [one.program, one.target]))

    for (const port of input.ports) {
      const pids = [...new Set(pidsOnPort(port).map(pid => owner.get(pid) ?? pid))]

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

  // in a project, its own boots: bare `term halt` stopped every boot on the machine, another project's included.
  // Outside any project there is no "own", and it stops them all, saying so
  const project = projectOf(process.cwd())
  openRun({ verb: 'halt', root: process.cwd(), facts: [project ? 'this project\'s term boot' : 'every term boot'] })

  const real = (folder: string): string => {
    try {
      return realpathSync(folder)
    } catch {
      return folder
    }
  }
  const here = project === undefined ? undefined : real(project)
  const found = boots().filter(one => here === undefined || real(one.project) === here)
  const targets = [...new Set(found.map(one => one.target))]
  let stopped = 0

  for (const pid of targets) {
    if (stop(pid)) {
      stopped++
      report({ glyph: 'done', kind: 'lifecycle', verb: 'stop', subject: 'term boot', facts: [`pid ${pid}`] })
    }
  }

  // the project's `term feed` and `term work` too, by where each was started; outside a project, every one
  const running = services().filter(one => here === undefined || (one.project !== undefined && real(one.project) === here))

  for (const one of running) {
    if (stop(one.pid)) {
      stopped++
      report({ glyph: 'done', kind: 'lifecycle', verb: 'stop', subject: `term ${one.verb}`, facts: [`pid ${one.pid}`] })
    }
  }

  closeRun({
    verdict: targets.length + running.length ? 'Stopped' : project ? 'No term boot of this project is running' : 'No term boot instance is running',
    counts: [count(stopped, 'instances', 'instance')],
  })
}
