// The node side of the driver seam. A driver is a child process that speaks JSON lines: one request per line on its
// standard input, one answer per line on its standard output, matched by `id`. The child is started on the first
// exchange, kept for the rest of the run and stopped when this process exits. Nothing here ever evaluates a line it
// reads: a line is parsed as data to find its `id`, and handed on as text. Reached only through the public driver API.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

type FindDriverEntry = {
  child: ChildProcess
  buffer: string
  waiting: Map<number, (line: string) => void>
}

type FindMounted = { tool: unknown; command: string; argumentList: string[] }

let findMountedNow: FindMounted | undefined
const findDriverTable =new Map<string, FindDriverEntry>()
let findDriverKey = ''
let findDriverCommand = ''
let findDriverArguments: string[] = []
let findDriverCounter = 0
let findDriverHooked = false

// the `id` of a line, -1 when it has none or is not JSON
const findDriverIdOf = (line: string): number => {
  try {
    const value = JSON.parse(line) as { id?: unknown }

    return typeof value.id === 'number' ? value.id : -1
  } catch {
    return -1
  }
}

// an answer standing in for a driver that could not answer
const findDriverFailure = (id: number, detail: string): string =>
  JSON.stringify({ id, ok: false, error: { kind: 'native', detail } })

// a driver with nothing pending does not hold this process open
const findDriverSettle = (entry: FindDriverEntry): void => {
  const streams = [entry.child.stdout, entry.child.stderr, entry.child.stdin] as unknown as ({
    ref?: () => void
    unref?: () => void
  } | null)[]

  for (const stream of streams) {
    if (entry.waiting.size > 0) {
      stream?.ref?.()
    } else {
      stream?.unref?.()
    }
  }

  if (entry.waiting.size > 0) {
    entry.child.ref()
  } else {
    entry.child.unref()
  }
}

const findDriverStopAll = (): void => {
  for (const entry of findDriverTable.values()) {
    entry.child.kill('SIGTERM')
  }
  findDriverTable.clear()
}

const findDriverStart = (): FindDriverEntry | undefined => {
  const known = findDriverTable.get(findDriverKey)

  if (known) {
    return known
  }

  if (findDriverCommand === '') {
    return undefined
  }

  try {
    const child = spawn(findDriverCommand, findDriverArguments, { stdio: ['pipe', 'pipe', 'inherit'] })
    const entry: FindDriverEntry = { child, buffer: '', waiting: new Map() }
    const fail = (detail: string) => {
      for (const [id, resolve] of [...entry.waiting]) {
        resolve(findDriverFailure(id, detail))
      }
      entry.waiting.clear()
      findDriverTable.delete(findDriverKey)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      entry.buffer += chunk
      let at = entry.buffer.indexOf('\n')
      while (at >= 0) {
        const line = entry.buffer.slice(0, at)
        entry.buffer = entry.buffer.slice(at + 1)
        const id = findDriverIdOf(line)
        const resolve = entry.waiting.get(id)
        if (resolve) {
          entry.waiting.delete(id)
          resolve(line)
        }
        at = entry.buffer.indexOf('\n')
      }
      findDriverSettle(entry)
    })
    child.stdin?.on('error', () => {})
    child.on('error', (cause: Error) => fail(String(cause)))
    child.on('exit', () => fail('the driver exited'))
    findDriverTable.set(findDriverKey, entry)
    if (!findDriverHooked) {
      findDriverHooked = true
      process.on('exit', findDriverStopAll)
    }

    return entry
  } catch {
    return undefined
  }
}

const findDriver = {
  // name the driver the next exchanges go to: the command and its arguments, as an argv, never through a shell
  use: (command: string, argumentList: string[]): void => {
    findDriverCommand = command
    findDriverArguments = argumentList
    findDriverKey = JSON.stringify([command, ...argumentList])
  },

  // mount a tool: make it and its driver the context, answer the context there was (nothing when none), to restore
  mount: (tool: unknown, command: string, argumentList: string[]): unknown => {
    const before = findMountedNow

    findMountedNow = { tool, command, argumentList }
    findDriverCommand = command
    findDriverArguments = argumentList
    findDriverKey = JSON.stringify([command, ...argumentList])

    return before ?? null
  },

  // put back the context `mount` answered: nothing means no tool and no driver
  restore: (before: unknown): void => {
    const previous = (before ?? undefined) as FindMounted | undefined

    findMountedNow = previous
    findDriverCommand = previous ? previous.command : ''
    findDriverArguments = previous ? previous.argumentList : []
    findDriverKey = JSON.stringify([findDriverCommand, ...findDriverArguments])
  },

  // run `work`, then put the context back, whether or not it raised: the raise goes on, unchanged
  runMounted: async (work: () => Promise<unknown>, before: unknown): Promise<void> => {
    try {
      await work()
    } finally {
      findDriver.restore(before)
    }
  },

  // whether a tool is mounted now
  mounted: (): boolean => findMountedNow !== undefined,

  // a fresh request number
  nextId: (): number => {
    findDriverCounter += 1

    return findDriverCounter
  },

  // send one line, answer the line whose `id` matches
  exchange: (line: string): Promise<string> =>
    new Promise(resolve => {
      const id = findDriverIdOf(line)
      const entry = findDriverStart()

      if (!entry) {
        resolve(findDriverFailure(id, 'no driver is chosen'))

        return
      }

      entry.waiting.set(id, resolve)
      findDriverSettle(entry)
      entry.child.stdin?.write(`${line}\n`)
    }),

  // stop every driver now
  stop: (): void => {
    findDriverStopAll()
  },
}
