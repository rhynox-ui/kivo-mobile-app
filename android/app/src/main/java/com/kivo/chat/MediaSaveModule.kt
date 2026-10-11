package com.kivo.chat

import android.content.ContentValues
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * Saves a chat photo into the phone's gallery under Pictures/Kivo. The bytes
 * come from the app (already downloaded with the user's own session), so no
 * token is handed to another app or system service.
 */
class MediaSaveModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = "MediaSaveModule"

  @ReactMethod
  fun saveImage(base64: String, mimeType: String, fileName: String, promise: Promise) {
    try {
      val bytes = Base64.decode(base64, Base64.DEFAULT)
      val mime = if (mimeType.startsWith("image/")) mimeType else "image/jpeg"
      val safeName = fileName.replace(Regex("[^A-Za-z0-9._-]"), "_")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val values = ContentValues().apply {
          put(MediaStore.Images.Media.DISPLAY_NAME, safeName)
          put(MediaStore.Images.Media.MIME_TYPE, mime)
          put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Kivo")
          put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val resolver = reactContext.contentResolver
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
          ?: throw IllegalStateException("Could not create the gallery entry.")
        resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IllegalStateException("Could not write the photo.")
        values.clear()
        values.put(MediaStore.Images.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
      } else {
        @Suppress("DEPRECATION")
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "Kivo")
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("Could not create Pictures/Kivo.")
        val file = File(dir, safeName)
        file.writeBytes(bytes)
        MediaScannerConnection.scanFile(reactContext, arrayOf(file.absolutePath), arrayOf(mime), null)
      }
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("SAVE_FAILED", e.message ?: "Could not save the photo.", e)
    }
  }
}
