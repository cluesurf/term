// List, from Are We Fast Yet, written by hand as plain idiomatic Kotlin (ours, 2026-10-03): AWFY's own shape, a node
// class whose `next` may be null, `makeList`, `isShorterThan` walking both, and the Takeuchi-style `tail`
class Element(val value: Long, val next: Element?) {
    fun length(): Long = if (next == null) 1 else 1 + next.length()
}

fun makeList(size: Long): Element? = if (size == 0L) null else Element(size, makeList(size - 1))

fun isShorterThan(x: Element?, y: Element?): Boolean {
    var xTail = x
    var yTail = y

    while (yTail != null) {
        if (xTail == null) return true

        xTail = xTail.next
        yTail = yTail.next
    }

    return false
}

fun tail(x: Element?, y: Element?, z: Element?): Element? =
    if (isShorterThan(y, x)) tail(tail(x!!.next, y, z), tail(y!!.next, z, x), tail(z!!.next, x, y)) else z

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 2
    var total = 0L

    repeat(n) { total += tail(makeList(15), makeList(10), makeList(6))!!.length() }

    println(total)
}
