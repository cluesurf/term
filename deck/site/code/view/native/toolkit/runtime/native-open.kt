// Handing things to the platform on Android (device-layer-0008), docked by ../open.tree as `<global:native-open>`, for
// both Android hosts. An address goes to whatever activity handles it (ACTION_VIEW); text goes to the share chooser
// (ACTION_SEND). Android 11 hides other apps from a query without a <queries> entry, so an intent is started and a
// missing handler is told by the exception, never by asking first.

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri

object nativeOpen {
    // opened, or unavailable when nothing handles the address (or it is not one)
    suspend fun address(address: String): String {
        val activity = hostActivity() ?: return "unavailable"
        val uri = Uri.parse(address)
        if (uri.scheme.isNullOrEmpty()) return "unavailable"
        return try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            "opened"
        } catch (e: ActivityNotFoundException) {
            "unavailable"
        }
    }

    // shown: the chooser is up, and the person decides
    suspend fun share(text: String): String {
        val activity = hostActivity() ?: return "unavailable"
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        return try {
            activity.startActivity(Intent.createChooser(send, null))
            "shown"
        } catch (e: ActivityNotFoundException) {
            "unavailable"
        }
    }
}
