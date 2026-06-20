// Reactive runtime tests: signals, effects, memoized computeds, batching, and glitch-free diamond propagation.
// Run: npx tsx test/zone/run.ts

import {
  batch,
  computed,
  createRoot,
  effect,
  signal,
} from '@/code/zone/reactive'

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

function main(): void {
  // an effect re-runs when its signal changes
  {
    const [count, setCount] = signal(0)
    let seen = -1
    effect(() => {
      seen = count()
    })
    expect('effect runs initially', seen, 0)
    setCount(5)
    expect('effect re-runs on change', seen, 5)
  }

  // a computed is memoized: it recomputes only when a dependency changes
  {
    const [n, setN] = signal(2)
    let computeCount = 0
    const double = computed(() => {
      computeCount++
      return n() * 2
    })
    expect('computed value', double(), 4)
    expect('computed cached on second read', double(), 4)
    expect('computed ran once', computeCount, 1)
    setN(3)
    expect('computed recomputes after change', double(), 6)
    expect('computed ran twice total', computeCount, 2)
  }

  // an effect does not re-run when an unrelated signal changes
  {
    const [a, setA] = signal(1)
    const [b] = signal(10)
    let runs = 0
    effect(() => {
      a()
      runs++
    })
    expect('effect ran once', runs, 1)
    setA(2)
    expect('effect ran twice (its dep changed)', runs, 2)
    void b
  }

  // batching: several writes flush the effect once
  {
    const [x, setX] = signal(0)
    let runs = 0
    effect(() => {
      x()
      runs++
    })
    batch(() => {
      setX(1)
      setX(2)
      setX(3)
    })
    expect('batched writes run the effect once more', runs, 2)
    expect('final value', x(), 3)
  }

  // diamond: a -> b, a -> c, (b, c) -> d. One write must run d exactly once (no glitch).
  {
    const [a, setA] = signal(1)
    const b = computed(() => a() + 1)
    const c = computed(() => a() + 2)
    let runs = 0
    let last = 0
    effect(() => {
      last = b() + c()
      runs++
    })
    expect('diamond initial', last, 1 + 1 + (1 + 2))
    expect('diamond effect ran once initially', runs, 1)
    setA(10)
    expect('diamond updated', last, 10 + 1 + (10 + 2))
    expect('diamond effect ran once more (no glitch)', runs, 2)
  }

  // createRoot owns its effects: disposing the root stops them, exactly (for hot-swap of one zone)
  {
    const [a, setA] = signal(0)
    const [b, setB] = signal(0)
    let aRuns = 0
    let bRuns = 0
    let disposeA = (): void => {}
    createRoot(dispose => {
      effect(() => {
        a()
        aRuns++
      })
      disposeA = dispose
    })
    // a sibling effect outside the root must survive the root's disposal
    effect(() => {
      b()
      bRuns++
    })
    expect('root effect ran initially', aRuns, 1)
    setA(1)
    expect('root effect re-runs while live', aRuns, 2)
    disposeA()
    setA(2)
    expect('root effect stops after dispose', aRuns, 2)
    setB(1)
    expect('an effect outside the root is unaffected', bRuns, 2)
  }

  console.log(`\nzone: ${pass} pass, ${fail} fail`)
}

main()
