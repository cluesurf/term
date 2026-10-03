// Kotlin's integer list, `TermLongs` (one LongArray behind a `MutableList<Long>`), is held against `java.util.ArrayList`
// operation for operation (codegen-performance F5). The same seeded sequence of 20,000 operations runs on both: every
// result must agree, every refusal must be the same exception class, and the two lists must be equal, hash alike and
// read alike after every step. Then the two factories, `addAll` from a TermLongs (the arraycopy path) and from a view,
// an iterator invalidated by a write, sort, a sub-list, and equality in both directions with an ArrayList.
// Run: npx tsx test/compile/kotlin-longs.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KOTLIN_LONGS } from '@term/make/code/compile/kotlin'

if (spawnSync('which', ['kotlinc']).status !== 0) {
  console.log('skip  kotlinc is not installed')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'kotlin-longs-'))
const file = join(dir, 'longs.kt')

writeFileSync(
  file,
  `${KOTLIN_LONGS}

fun <T> outcome(body: () -> T): String = try { "ok " + body() } catch (e: Exception) { "throw " + e.javaClass.simpleName }

fun main() {
    var fails = 0
    fun check(name: String, holds: Boolean, detail: String = "") {
        if (holds) println("ok    " + name) else { fails++; println("FAIL  " + name + if (detail.isEmpty()) "" else "\\n        " + detail) }
    }

    // 1. one seeded sequence on both
    val random = java.util.Random(20261002)
    val ours = mutableLongListOf()
    val theirs: MutableList<Long> = java.util.ArrayList()
    var differ = ""
    for (step in 0 until 20000) {
        // an index a little past either end, so the refusals are exercised as often as the writes
        val at = random.nextInt(ours.size + 3) - 1
        val value = random.nextLong() shr random.nextInt(64)
        val op = random.nextInt(9)
        // drawn once, so both lists are cleared together
        val wipe = op == 8 && random.nextInt(50) == 0
        val a = when (op) {
            0, 1 -> outcome { ours.add(value) }
            2 -> outcome { ours.add(at, value) }
            3 -> outcome { ours[at] }
            4 -> outcome { ours.set(at, value) }
            5 -> outcome { ours.removeAt(at) }
            6 -> outcome { ours.indexOf(value) }
            7 -> outcome { ours.addAll(listOf(value, value + 1)) }
            else -> outcome { if (wipe) ours.clear() else ours.size }
        }
        val b = when (op) {
            0, 1 -> outcome { theirs.add(value) }
            2 -> outcome { theirs.add(at, value) }
            3 -> outcome { theirs[at] }
            4 -> outcome { theirs.set(at, value) }
            5 -> outcome { theirs.removeAt(at) }
            6 -> outcome { theirs.indexOf(value) }
            7 -> outcome { theirs.addAll(listOf(value, value + 1)) }
            else -> outcome { if (wipe) theirs.clear() else theirs.size }
        }
        if (a != b || ours != theirs || ours.hashCode() != theirs.hashCode()) {
            differ = "step " + step + " op " + op + " at " + at + ": " + a + " against " + b
            break
        }
    }
    check("20,000 seeded operations agree with ArrayList", differ.isEmpty(), differ)

    // 2. the factories and the arraycopy path
    val made = mutableLongListOf(3L, -1L, Long.MAX_VALUE, Long.MIN_VALUE)
    check("the vararg factory holds its items in order", made == listOf(3L, -1L, Long.MAX_VALUE, Long.MIN_VALUE), made.toString())
    val copied = mutableLongListOf(made)
    copied.add(9L)
    check("the copy factory copies, never aliases", made.size == 4 && copied.size == 5 && copied.subList(0, 4) == made)
    val grown = mutableLongListOf()
    for (i in 0 until 1000) grown.addAll(made)
    check("addAll from a TermLongs grows past its capacity", grown.size == 4000 && grown[3999] == Long.MIN_VALUE && grown[2] == Long.MAX_VALUE)
    val fromView = mutableLongListOf(made.asReversed())
    check("addAll from a view", fromView == listOf(Long.MIN_VALUE, Long.MAX_VALUE, -1L, 3L), fromView.toString())
    val self = mutableLongListOf(1L, 2L)
    self.addAll(self)
    check("addAll of itself doubles it", self == listOf(1L, 2L, 1L, 2L), self.toString())

    // 3. the List contract
    val walked = mutableLongListOf(1L, 2L, 3L)
    check("an iterator a write invalidates fails fast", outcome { for (x in walked) if (x == 1L) walked.add(4L) } == "throw ConcurrentModificationException")
    val sorted = mutableLongListOf(5L, -2L, 9L, 0L)
    sorted.sort()
    check("sort", sorted == listOf(-2L, 0L, 5L, 9L), sorted.toString())
    val window = mutableLongListOf(1L, 2L, 3L, 4L, 5L)
    window.subList(1, 3).clear()
    check("a sub-list writes through", window == listOf(1L, 4L, 5L), window.toString())
    val plain: MutableList<Long> = java.util.ArrayList(listOf(7L, 8L))
    check("equal to an ArrayList both ways", mutableLongListOf(7L, 8L) == plain && plain == mutableLongListOf(7L, 8L))
    check("the same hash as an ArrayList", mutableLongListOf(7L, 8L).hashCode() == plain.hashCode())
    check("a hash key equal to an ArrayList finds it", hashMapOf<List<Long>, String>(plain to "found")[mutableLongListOf(7L, 8L)] == "found")
    check("toString as an ArrayList", mutableLongListOf(7L, 8L).toString() == plain.toString())
    check("a read past the end is ArrayList's refusal", outcome { mutableLongListOf(1L)[1] } == outcome { java.util.ArrayList(listOf(1L))[1] })
    check("a pop of the last", outcome { mutableLongListOf(1L, 2L).run { removeAt(lastIndex) } } == "ok 2")
    check("a pop of an empty list is ArrayList's refusal", outcome { mutableLongListOf().run { removeAt(lastIndex) } } == outcome { java.util.ArrayList<Long>().run { removeAt(lastIndex) } })

    println("\\nkotlin-longs: " + if (fails == 0) "every check passes" else fails.toString() + " failed")
    if (fails > 0) kotlin.system.exitProcess(1)
}
`,
)

const jar = join(dir, 'longs.jar')
execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: ['ignore', 'pipe', 'inherit'] })
const ran = spawnSync('java', ['-jar', jar], { encoding: 'utf8' })
process.stdout.write(ran.stdout)
process.stderr.write(ran.stderr)
process.exit(ran.status ?? 1)
