// The hand-back the emitted program's loop carries (compile/kotlin.ts, `termLoop.handBack`, decision 001), stood in
// for: this suite drives the shims under kotlinx's `runBlocking`, so the blocking call goes to `Dispatchers.IO`. The
// loop's own hand-back is proven by test/compile/hand-back-native.ts, through the compiler.
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object termLoop {
  suspend fun <T> handBack(work: () -> T): T = withContext(Dispatchers.IO) { work() }
}
