// Atomic integer runtime over java.util.concurrent.atomic.AtomicLong. The opaque handle a seed atomic holds is the
// AtomicLong. Reached only through the public atomic API.
object atomic {
    fun make(initial: Long): java.util.concurrent.atomic.AtomicLong =
        java.util.concurrent.atomic.AtomicLong(initial)
    fun load(cell: java.util.concurrent.atomic.AtomicLong): Long = cell.get()
    fun store(cell: java.util.concurrent.atomic.AtomicLong, value: Long) {
        cell.set(value)
    }
    fun increase(cell: java.util.concurrent.atomic.AtomicLong, delta: Long): Long =
        cell.addAndGet(delta)
}
