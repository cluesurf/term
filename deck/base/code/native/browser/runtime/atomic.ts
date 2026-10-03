// Atomic integer runtime over Atomics on a BigInt64Array, so the cell holds the same 64-bit integer as Rust's
// AtomicI64, Swift's and Kotlin's (it was an Int32Array, which wrapped at 2^31 on JavaScript alone). Shared with a
// worker when SharedArrayBuffer exists; a page without cross-origin isolation gets a plain buffer, which is enough on
// one thread. The opaque handle a Term atomic holds is the typed array. Reached only through the public atomic API.
const atomic = {
  make: (initial: number): BigInt64Array => {
    const buffer = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(8) : new ArrayBuffer(8)
    const cell = new BigInt64Array(buffer)
    Atomics.store(cell, 0, BigInt(initial))
    return cell
  },
  load: (cell: BigInt64Array): number => Number(Atomics.load(cell, 0)),
  store: (cell: BigInt64Array, value: number): void => {
    Atomics.store(cell, 0, BigInt(value))
  },
  increase: (cell: BigInt64Array, delta: number): number =>
    Number(Atomics.add(cell, 0, BigInt(delta)) + BigInt(delta)),
}
