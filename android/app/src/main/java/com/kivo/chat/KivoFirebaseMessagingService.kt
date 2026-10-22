package com.kivo.chat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger

/** Displays followed-trade pushes while Kivo is foregrounded and preserves tap routing. */
class KivoFirebaseMessagingService : FirebaseMessagingService() {
  companion object {
    private const val CHANNEL_ID = "trade-activity"
    private val nextId = AtomicInteger(20_000)
  }
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    if (data["type"] != "followed_trade") return
    val title = message.notification?.title ?: "Kivo trade activity"
    val body = message.notification?.body ?: "A profile you follow completed a trade."
    try {
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Followed trades", NotificationManager.IMPORTANCE_DEFAULT).apply {
          description = "Trades from Kivo profiles you follow"
        })
      }
      val launch = Intent(this, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        data.forEach { (key, value) -> putExtra(key, value) }
      }
      val pending = PendingIntent.getActivity(this, nextId.get(), launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val builder = NotificationCompat.Builder(this, CHANNEL_ID).setSmallIcon(applicationInfo.icon)
        .setContentTitle(title).setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setContentIntent(pending).setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_DEFAULT)
      val imageUrl = message.notification?.imageUrl?.toString()
      if (!imageUrl.isNullOrBlank()) {
        runCatching { URL(imageUrl).openStream().use { BitmapFactory.decodeStream(it) } }.getOrNull()?.let(builder::setLargeIcon)
      }
      NotificationManagerCompat.from(this).notify(nextId.getAndIncrement(), builder.build())
    } catch (_: SecurityException) {
      // User denied notifications; never crash the Firebase worker.
    } catch (_: Exception) {
      // A failed avatar download or notification must not affect the app.
    }
  }
}
