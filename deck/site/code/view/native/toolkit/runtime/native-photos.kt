// The person's photo library on Android (device-layer-0025), docked by ../photos.tree as `<global:native-photos>`, for
// both Android hosts. The MediaStore provider's images: every row's id, when it was taken (else added) and its size,
// sorted here newest first, since the provider's sort cannot fall back from one column to the other. A copy is the
// image decoded and written to the app's cache as a JPEG, whatever the library kept it as. Times are UTC to the second
// (../../../photos.tree). Without the grant every task answers the grant's status and never prompts.

import android.content.ContentUris
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.provider.MediaStore
import java.io.File

object nativePhotos {
    // the newest `count` photos, `id<TAB>taken<TAB>WIDTHxHEIGHT` a line; or none, or the grant's status
    suspend fun newest(count: Long): String {
        refusal()?.let { return it }
        val activity = hostActivity() ?: return "unavailable"
        // when it was taken, the id, and the size the provider holds, which is 0 by 0 until its scanner has read the file
        val found = mutableListOf<Triple<Long, Long, Pair<Int, Int>>>()
        try {
            val columns = arrayOf(
                MediaStore.Images.Media._ID,
                MediaStore.Images.Media.DATE_TAKEN,
                MediaStore.Images.Media.DATE_ADDED,
                MediaStore.Images.Media.WIDTH,
                MediaStore.Images.Media.HEIGHT,
            )
            activity.contentResolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, columns, null, null, null)?.use { row ->
                while (row.moveToNext()) {
                    // DATE_TAKEN is milliseconds and may be absent; DATE_ADDED is seconds
                    val taken = if (row.isNull(1) || row.getLong(1) == 0L) row.getLong(2) * 1000 else row.getLong(1)
                    found.add(Triple(taken, row.getLong(0), row.getInt(3) to row.getInt(4)))
                }
            }
            if (found.isEmpty()) return "none"
            return found.sortedByDescending { it.first }.take(count.toInt()).joinToString("\n") { (taken, id, size) ->
                val (width, height) = if (size.first > 0 && size.second > 0) size else bounds(activity, id)
                "$id\t${write(taken)}\t${width}x$height"
            }
        } catch (e: SecurityException) {
            return "denied"
        } catch (e: Exception) {
            return "failed"
        }
    }

    // a photo's size read from its own header, for a row the provider's scanner has not reached yet
    private fun bounds(activity: android.app.Activity, id: Long): Pair<Int, Int> {
        val options = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        activity.contentResolver.openInputStream(ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id))?.use {
            android.graphics.BitmapFactory.decodeStream(it, null, options)
        }
        return options.outWidth.coerceAtLeast(0) to options.outHeight.coerceAtLeast(0)
    }

    // `photo <path>`, a JPEG in the app's cache; or absent, failed, or the grant's status
    suspend fun export(id: String): String {
        refusal()?.let { return it }
        val activity = hostActivity() ?: return "unavailable"
        val number = id.toLongOrNull() ?: return "absent"
        val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, number)
        return try {
            val image = ImageDecoder.decodeBitmap(ImageDecoder.createSource(activity.contentResolver, uri)) { decoder, _, _ ->
                // a software bitmap, which compress can read
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
            val file = File(activity.externalCacheDir ?: activity.cacheDir, "term-photo-${System.currentTimeMillis()}.jpg")
            file.outputStream().use { image.compress(Bitmap.CompressFormat.JPEG, 90, it) }
            "photo ${file.path}"
        } catch (e: java.io.FileNotFoundException) {
            "absent"
        } catch (e: SecurityException) {
            "denied"
        } catch (e: Exception) {
            "failed"
        }
    }

    private suspend fun refusal(): String? {
        val grant = nativePermission.status("photos")
        return if (grant == "granted") null else grant
    }

    // UTC, to the second: `2030-01-01T09:00:00Z`
    private fun write(milliseconds: Long): String =
        java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(java.time.ZoneOffset.UTC)
            .format(java.time.Instant.ofEpochMilli(milliseconds))
}
