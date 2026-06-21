/**
 * Bounded-concurrency scheduling for verification work. Many obligations
 * are independent - distinct files, distinct synthesis candidates,
 * distinct SMT queries - so they can run concurrently. `mapConcurrent`
 * runs up to `concurrency` jobs at once, preserving result order, so the
 * async-bound work (Z3 `check()` awaits the WASM solver) overlaps
 * instead of serializing.
 *
 * This is the parallel-proving performance key for the solver path. For
 * CPU-bound synchronous work (the bounded exhaustive prover, the
 * enumerator) true parallelism needs worker threads; that is a separate
 * step. Here we win on the async path, which is where the SMT proofs and
 * the AI proposer live.
 */

const DEFAULT_CONCURRENCY = 8

/**
 * Map `worker` over `items` with at most `concurrency` in flight at
 * once. Results come back in input order. A worker that rejects rejects
 * the whole call (use a worker that catches if you want per-item
 * failures as values).
 */
export async function mapConcurrent<A, B>(
  items: A[],
  worker: (item: A, index: number) => Promise<B>,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<B[]> {
  const results = new Array<B>(items.length)
  let next = 0

  async function run(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  }

  // launch `concurrency` runners that pull from the shared cursor
  const lanes = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => run(),
  )
  await Promise.all(lanes)
  return results
}

/** The max concurrency to use by default (cap at the CPU count when known). */
export function defaultConcurrency(cpuCount?: number): number {
  if (!cpuCount || cpuCount < 1) return DEFAULT_CONCURRENCY
  return Math.max(1, Math.min(DEFAULT_CONCURRENCY, cpuCount))
}
