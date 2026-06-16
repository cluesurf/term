// The fine-grained reactive runtime that zone components compile onto: signals, memoized computeds, and effects,
// with automatic dependency tracking and batched, dedup'd propagation. This is the Solid model (run-once, no
// virtual DOM), the structure zones target. Browser-safe, no host APIs. See
// note/research/vibe/computation/plans/14-reactivity.md and 15-components.md.

type Observer = { run: () => void; sources: Set<Source> }
type Source = { observers: Set<Observer> }

let currentObserver: Observer | undefined
let batchDepth = 0
const pending = new Set<Observer>()

function track(source: Source): void {
  if (currentObserver) {
    currentObserver.sources.add(source)
    source.observers.add(currentObserver)
  }
}

function trigger(source: Source): void {
  // snapshot, because running observers may re-link sources
  for (const observer of [...source.observers]) schedule(observer)
}

function schedule(observer: Observer): void {
  pending.add(observer)
  if (batchDepth === 0) flush()
}

function flush(): void {
  // loop until settled; insertion order runs computeds (scheduled first) before the effects that read them
  while (pending.size > 0) {
    const next = pending.values().next().value as Observer
    pending.delete(next)
    next.run()
  }
}

function detach(observer: Observer): void {
  for (const source of observer.sources) source.observers.delete(observer)
  observer.sources.clear()
}

// a reactive cell: read subscribes the current observer, write notifies
export function signal<T>(initial: T): [read: () => T, write: (value: T) => void] {
  let value = initial
  const source: Source = { observers: new Set() }
  const read = (): T => {
    track(source)
    return value
  }
  const write = (next: T): void => {
    if (Object.is(next, value)) return
    value = next
    batchDepth++
    try {
      trigger(source)
    } finally {
      batchDepth--
      if (batchDepth === 0) flush()
    }
  }
  return [read, write]
}

// a memoized derivation: recomputes only when a dependency changed, only when read
export function computed<T>(compute: () => T): () => T {
  let value: T
  let dirty = true
  const source: Source = { observers: new Set() }
  const observer: Observer = {
    sources: new Set(),
    run() {
      if (!dirty) {
        dirty = true
        trigger(source)
      }
    },
  }
  return (): T => {
    if (dirty) {
      detach(observer)
      const previous = currentObserver
      currentObserver = observer
      try {
        value = compute()
      } finally {
        currentObserver = previous
      }
      dirty = false
    }
    track(source)
    return value
  }
}

// a side effect: runs now, re-runs when its dependencies change; returns a disposer
export function effect(run: () => void): () => void {
  const observer: Observer = {
    sources: new Set(),
    run() {
      detach(observer)
      const previous = currentObserver
      currentObserver = observer
      try {
        run()
      } finally {
        currentObserver = previous
      }
    },
  }
  observer.run()
  return () => detach(observer)
}

// group several writes so dependents update once, after the batch
export function batch(run: () => void): void {
  batchDepth++
  try {
    run()
  } finally {
    batchDepth--
    if (batchDepth === 0) flush()
  }
}
