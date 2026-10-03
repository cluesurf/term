// Storage, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Kotlin (ours,
// 2026-10-03): a tree of arrays seven levels deep built by recursion, AWFY's generator sizing each leaf, the arrays
// counted and every leaf's length read back, run `n` times and added
sealed class Tree
class Leaf(val items: LongArray) : Tree()
class Node(val kids: Array<Tree>) : Tree()

class Random {
    private var seed = 74755L

    fun next(): Long {
        seed = (seed * 1309 + 13849) and 65535
        return seed
    }
}

class Storage {
    var count = 0L
    private val random = Random()

    fun build(depth: Int): Tree {
        count++

        if (depth == 1) {
            return Leaf(LongArray((random.next() % 10 + 1).toInt()))
        }

        return Node(Array(4) { build(depth - 1) })
    }
}

fun leaves(tree: Tree): Long = when (tree) {
    is Leaf -> tree.items.size.toLong()
    is Node -> tree.kids.sumOf { leaves(it) }
}

fun main(args: Array<String>) {
    val n = args.getOrNull(0)?.toInt() ?: 3
    var total = 0L

    repeat(n) {
        val storage = Storage()
        val tree = storage.build(7)
        total += storage.count + leaves(tree)
    }

    println(total)
}
