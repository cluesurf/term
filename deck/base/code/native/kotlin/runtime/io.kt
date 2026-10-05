import java.io.File

// `kotlin.Exception` in full: a program that loads @term/base/exception declares its own `Exception`, the stdlib
// form, in the same file this shim is prepended to, and a bare `Exception` here then named it and did not compile
object io {
    fun fileRead(path: String): String = try { File(path).readText() } catch (e: kotlin.Exception) { "" }
    fun fileWrite(path: String, data: String) { try { File(path).writeText(data) } catch (e: kotlin.Exception) {} }
    fun fileReadBytes(path: String): ByteArray = try { File(path).readBytes() } catch (e: kotlin.Exception) { ByteArray(0) }
    fun fileWriteBytes(path: String, data: ByteArray) { try { File(path).writeBytes(data) } catch (e: kotlin.Exception) {} }
    fun fileAppend(path: String, data: String) { try { File(path).appendText(data) } catch (e: kotlin.Exception) {} }
    fun fileRemove(path: String) { try { File(path).delete() } catch (e: kotlin.Exception) {} }
    fun fileCopy(from: String, to: String) { try { File(from).copyTo(File(to), overwrite = true) } catch (e: kotlin.Exception) {} }
    fun fileMove(from: String, to: String) { try { File(from).copyTo(File(to), overwrite = true); File(from).delete() } catch (e: kotlin.Exception) {} }
    fun fileExists(path: String): Boolean = File(path).exists()
    fun fileSize(path: String): Long = try { File(path).length() } catch (e: kotlin.Exception) { 0L }
    fun isDirectory(path: String): Boolean = File(path).isDirectory
    fun isFile(path: String): Boolean = File(path).isFile
    fun dirMake(path: String) { try { File(path).mkdirs() } catch (e: kotlin.Exception) {} }
    fun dirRemove(path: String) { try { File(path).deleteRecursively() } catch (e: kotlin.Exception) {} }
    fun dirList(path: String): MutableList<String> = try { File(path).list()?.toMutableList() ?: mutableListOf() } catch (e: kotlin.Exception) { mutableListOf() }
    fun dirWalk(path: String): MutableList<String> = try { File(path).walkTopDown().drop(1).map { it.path }.toMutableList() } catch (e: kotlin.Exception) { mutableListOf() }
}
