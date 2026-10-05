// binary-trees, the same algorithm as term.tree, written by hand as plain idiomatic Kotlin (ours, 2026-10-02): a node
// per allocation, as the Benchmarks Game requires. A sealed class with a single `Leaf` object, which is how Kotlin
// writes such a tree: a first version allocated `Tree(null, null)` for every leaf and ran slower than Term's output,
// which said more about that version than about either
sealed class Tree
object Leaf : Tree()
class Branch(val left: Tree, val right: Tree) : Tree()

fun bottomUp(depth: Int): Tree = if (depth > 0) Branch(bottomUp(depth - 1), bottomUp(depth - 1)) else Leaf

fun itemCheck(tree: Tree): Int = when (tree) {
    is Leaf -> 1
    is Branch -> 1 + itemCheck(tree.left) + itemCheck(tree.right)
}

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 10
    val maxDepth = maxOf(6, n)
    val stretchDepth = maxDepth + 1
    val lines = mutableListOf("stretch tree of depth $stretchDepth\t check: ${itemCheck(bottomUp(stretchDepth))}")
    val longLived = bottomUp(maxDepth)
    var depth = 4
    while (depth <= maxDepth) {
        val iterations = 1 shl (maxDepth - depth + 4)
        var check = 0
        repeat(iterations) { check += itemCheck(bottomUp(depth)) }
        lines.add("$iterations\t trees of depth $depth\t check: $check")
        depth += 2
    }
    lines.add("long lived tree of depth $maxDepth\t check: ${itemCheck(longLived)}")
    println(lines.joinToString("\n"))
}
