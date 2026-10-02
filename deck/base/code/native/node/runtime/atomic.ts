// Atomic integer runtime over Atomics on a SharedArrayBuffer-backed Int32Array, so the cell is safe to share with a
// worker thread. The opaque handle a seed atomic holds is the typed array. Reached only through the public atomic API.
const atomic = {
  make: (initial: number): Int32Array => {
    const cell = new Int32Array(new SharedArrayBuffer(4))
    Atomics.store(cell, 0, initial)
    return cell
  },
  load: (cell: Int32Array): number => Atomics.load(cell, 0),
  store: (cell: Int32Array, value: number): void => {
    Atomics.store(cell, 0, value)
  },
  increase: (cell: Int32Array, delta: number): number =>
    Atomics.add(cell, 0, delta) + delta,
}
