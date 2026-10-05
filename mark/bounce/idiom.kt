// Bounce, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Kotlin (ours,
// 2026-10-03): AWFY's own shape, a generator and a list of balls whose fields `bounce` changes in place
import kotlin.math.abs

class Random {
    private var seed = 74755L

    fun next(): Long {
        seed = (seed * 1309 + 13849) and 65535
        return seed
    }
}

class Ball(random: Random) {
    private var x = random.next() % 500
    private var y = random.next() % 500
    private var dx = random.next() % 300 - 150
    private var dy = random.next() % 300 - 150

    fun bounce(): Boolean {
        var bounced = false
        x += dx
        y += dy

        if (x > 500) {
            x = 500
            dx = -abs(dx)
            bounced = true
        }

        if (x < 0) {
            x = 0
            dx = abs(dx)
            bounced = true
        }

        if (y > 500) {
            y = 500
            dy = -abs(dy)
            bounced = true
        }

        if (y < 0) {
            y = 0
            dy = abs(dy)
            bounced = true
        }

        return bounced
    }
}

fun run(): Long {
    val random = Random()
    val balls = List(100) { Ball(random) }
    var bounces = 0L

    repeat(50) {
        for (ball in balls) {
            if (ball.bounce()) bounces++
        }
    }

    return bounces
}

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 2
    var total = 0L

    repeat(n) { total += run() }

    println(total)
}
