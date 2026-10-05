// The watchers' fan-out in a browser (device-layer-0016), docked as `<global:native-watch>` by every host tree whose
// capability can be watched. Many handlers share one subscription per capability: the first watch starts it, the last
// drop stops it, and a watch made while it runs hears the last answer at once, so every handler is told the current
// value first. Its state, and its one type, live on the object: every runtime a page links is joined into one module in
// front of the program, so a top-level name here could collide with one of the program's own.

export const nativeWatch = {
  topics: new Map<string, { handlers: Map<number, (value: string) => void>; last?: string; stop: () => void }>(),
  next: 0,

  // `handler` added to the capability `name`, and the number that removes it. `start` begins the subscription with the
  // function every answer goes through, and answers the function that ends it
  join(name: string, handler: (value: string) => void, start: (tell: (value: string) => void) => () => void): number {
    const id = ++nativeWatch.next
    const topic = nativeWatch.topics.get(name) ?? { handlers: new Map<number, (value: string) => void>(), last: undefined as string | undefined, stop: () => {} }
    nativeWatch.topics.set(name, topic)
    topic.handlers.set(id, handler)

    if (topic.handlers.size > 1) {
      if (topic.last !== undefined) {
        handler(topic.last)
      }

      return id
    }

    const stop = start(value => {
      topic.last = value

      // in the order they joined, and over a copy: a handler may drop itself, or another, as it is told
      for (const key of [...topic.handlers.keys()]) {
        topic.handlers.get(key)?.(value)
      }
    })

    // a handler told at once may have dropped itself before the subscription's end was known
    if (nativeWatch.topics.get(name) === topic) {
      topic.stop = stop
    } else {
      stop()
    }

    return id
  },

  leave(name: string, id: number): void {
    const topic = nativeWatch.topics.get(name)

    if (!topic || !topic.handlers.delete(id) || topic.handlers.size > 0) {
      return
    }

    nativeWatch.topics.delete(name)
    topic.stop()
  },
}
