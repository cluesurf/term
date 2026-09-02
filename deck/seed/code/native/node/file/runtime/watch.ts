// Filesystem watching for node, over `fs.watch`, which is libuv's FSEvents / inotify binding and not a polling
// loop.
//
// The API is PULL, not callback: `watchOpen` starts the watch, `watchNext` awaits the next change, `watchClose`
// stops it. node is the ONE backend where a callback shape would have been natural, and it does not get one: the
// other three cannot hold it (a Term task value would have to cross into a platform thread), so the shape all
// four can hold is the shape all four get. What node contributes here is a queue in front of an event emitter.
//
// Reached only through the public file/watch API.
import * as fs from 'node:fs'
import * as path from 'node:path'

type Event = { kind: string; path: string }

type Watcher = {
  watcher: fs.FSWatcher | undefined
  ready: Event[]
  waiting: ((event: Event) => void) | undefined
  closed: boolean
}

const EMPTY: Event = { kind: '', path: '' }

const watch = {
  watchOpen: async (at: string, deep: boolean): Promise<Watcher> => {
    const held: Watcher = {
      watcher: undefined,
      ready: [],
      waiting: undefined,
      closed: false,
    }

    // hand the change to whoever is waiting, or hold it until someone asks
    const post = (event: Event): void => {
      const waiter = held.waiting

      if (waiter) {
        held.waiting = undefined
        waiter(event)

        return
      }

      held.ready.push(event)
    }

    try {
      held.watcher = fs.watch(at, { recursive: deep }, (event, name) => {
        // node reports 'rename' for both a create and a remove, so which one it was is whether the path is
        // still there. Anything else is a content change.
        const whole = name ? path.join(at, name.toString()) : at

        if (event === 'rename') {
          post({
            kind: fs.existsSync(whole) ? 'create' : 'remove',
            path: whole,
          })

          return
        }

        post({ kind: 'change', path: whole })
      })
    } catch {
      held.closed = true
    }

    return held
  },

  // the next change. A closed watcher answers with the empty event rather than waiting forever, so a loop over
  // `watchNext` ends after `watchClose`.
  watchNext: async (held: Watcher): Promise<Event> => {
    const already = held.ready.shift()

    if (already) {
      return already
    }

    if (held.closed) {
      return EMPTY
    }

    return new Promise<Event>(answer => {
      held.waiting = answer
    })
  },

  watchClose: async (held: Watcher): Promise<void> => {
    held.closed = true
    held.watcher?.close()
    held.watcher = undefined

    const waiter = held.waiting
    held.waiting = undefined
    waiter?.(EMPTY)
  },
}
