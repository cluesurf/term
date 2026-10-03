// Graph, ours, the same structure as term.tree, written by hand as plain idiomatic Kotlin (2026-10-03): a grid's
// adjacency lists built fresh each run and searched breadth-first from the corner, the distances added
fun neighbors(side: Int): List<IntArray> {
    val cells = ArrayList<IntArray>(side * side)

    for (at in 0 until side * side) {
        val row = at / side
        val column = at % side
        val near = ArrayList<Int>(4)

        if (row > 0) near.add(at - side)
        if (column > 0) near.add(at - 1)
        if (column < side - 1) near.add(at + 1)
        if (row < side - 1) near.add(at + side)

        cells.add(near.toIntArray())
    }

    return cells
}

fun search(cells: List<IntArray>): Long {
    val distance = IntArray(cells.size) { -1 }
    val queue = IntArray(cells.size)
    var tail = 0
    queue[tail++] = 0
    distance[0] = 0
    var total = 0L
    var head = 0

    while (head < tail) {
        val at = queue[head++]
        val here = distance[at]
        total += here

        for (next in cells[at]) {
            if (distance[next] == -1) {
                distance[next] = here + 1
                queue[tail++] = next
            }
        }
    }

    return total
}

fun main(args: Array<String>) {
    val n = args.getOrNull(0)?.toInt() ?: 3
    var total = 0L

    repeat(n) {
        total += search(neighbors(40))
    }

    println(total)
}
