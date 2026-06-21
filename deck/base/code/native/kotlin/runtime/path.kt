import java.io.File

// Path manipulation over java.io.File. The file extension carries its leading dot.
object path {
    fun join(base: String, name: String): String = File(base, name).path
    fun directory(target: String): String = File(target).parent ?: ""
    fun fileName(target: String): String = File(target).name
    fun fileExtension(target: String): String {
        val value = File(target).extension
        return if (value.isEmpty()) "" else ".$value"
    }
    fun isAbsolute(target: String): Boolean = File(target).isAbsolute
}
