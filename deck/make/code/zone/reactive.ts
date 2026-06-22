// The fine-grained reactive runtime that zone components compile onto: signals, memoized computeds, and effects,
// with automatic dependency tracking and batched, dedup'd propagation. This is the Solid model (run-once, no
// virtual DOM), the structure zones target. Browser-safe, no host APIs. See
// note/research/vibe/computation/plans/14-reactivity.md and 15-components.md.

type Observer = { run: () => void; sources: Set<Source> }
type Source = { observers: Set<Observer> }
// a reactive ownership scope: the disposers (effect teardowns) created under it. A zone runs its setup inside one
// scope, so a hot swap can tear down exactly that zone's reactive graph and nothing else. See createRoot.
type Scope = { disposers: Set<() => void> }

let currentObserver: Observer | undefined
let currentScope: Scope | undefined
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
  for (const observer of [...source.observers]) {
    schedule(observer)
  }
}

function schedule(observer: Observer): void {
  pending.add(observer)

  if (batchDepth === 0) {
    flush()
  }
}

function flush(): void {
  // loop until settled; insertion order runs computeds (scheduled first) before the effects that read them
  while (pending.size > 0) {
    const next = pending.values().next().value!
    pending.delete(next)
    next.run()
  }
}

function detach(observer: Observer): void {
  for (const source of observer.sources) {
    source.observers.delete(observer)
  }

  observer.sources.clear()
}

// a reactive cell: read subscribes the current observer, write notifies
export function signal<T>(
  initial: T,
): [read: () => T, write: (value: T) => void] {
  let value = initial

  const source: Source = { observers: new Set() }

  const read = (): T => {
    track(source)

    return value
  }

  const write = (next: T): void => {
    if (Object.is(next, value)) {
      return
    }

    value = next
    batchDepth++

    try {
      trigger(source)
    } finally {
      batchDepth--

      if (batchDepth === 0) {
        flush()
      }
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

  const dispose = (): void => detach(observer)
  // an effect created inside a scope is owned by it, so disposing the scope tears the effect down
  currentScope?.disposers.add(dispose)

  return dispose
}

// run `fn` inside a fresh ownership scope. Every effect created during `fn` (transitively) is owned by the scope.
// `fn` receives a `dispose` that tears them all down. This is the unit a zone is mounted in, so a hot swap disposes
// exactly one zone's reactive graph before re-running it. Returns whatever `fn` returns.
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const scope: Scope = { disposers: new Set() }

  const dispose = (): void => {
    for (const disposer of scope.disposers) {
      disposer()
    }

    scope.disposers.clear()
  }

  const previous = currentScope
  currentScope = scope

  try {
    return fn(dispose)
  } finally {
    currentScope = previous
  }
}

// group several writes so dependents update once, after the batch
export function batch(run: () => void): void {
  batchDepth++

  try {
    run()
  } finally {
    batchDepth--

    if (batchDepth === 0) {
      flush()
    }
  }
}
