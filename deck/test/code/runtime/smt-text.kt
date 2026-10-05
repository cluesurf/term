// The solver binding on Kotlin: SMT-LIB2 text in, Z3's answer out, through a `z3 -in` process per script. The node
// binding (smt-text.ts) keeps one Z3 context, and this keeps none, which is why smt-query.tree sends each question as
// one self-contained script, the model asked for in the same text. `TERM_Z3` names the binary, else `z3` on the path.
object smtText {
    fun evaluate(text: String): String {
        val binary = System.getenv("TERM_Z3") ?: "z3"
        val process = try {
            ProcessBuilder(binary, "-in").redirectError(ProcessBuilder.Redirect.DISCARD).start()
        } catch (e: java.lang.Exception) {
            return "unknown"
        }

        process.outputStream.bufferedWriter().use { it.write(text + "\n(exit)\n") }
        val answer = process.inputStream.bufferedReader().readText()
        process.waitFor()

        return answer
    }
}
