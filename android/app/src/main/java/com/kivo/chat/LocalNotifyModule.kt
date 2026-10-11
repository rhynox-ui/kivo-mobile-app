package com.kivo.chat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.atomic.AtomicInteger

/**
 * Posts a local, device-only notification (no push service, nothing sent to a
 * server) for things the app detected itself: trades, deposits, withdrawals.
 * Ported from Mango Pro's LocalNotifyModule. Never throws for a missing
 * permission; it just reports that nothing was shown.
 */
class LocalNotifyModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = "LocalNotifyModule"

  companion object {
    private const val CHANNEL_ID = "kivo_wallet_activity"
    private val nextId = AtomicInteger(1)
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(CHANNEL_ID, "Wallet activity", NotificationManager.IMPORTANCE_DEFAULT)
    channel.description = "Trades, deposits and withdrawals in your Kivo wallet"
    manager.createNotificationChannel(channel)
  }

  @ReactMethod
  fun notify(title: String, body: String, promise: Promise) {
    try {
      val compat = NotificationManagerCompat.from(reactContext)
      if (!compat.areNotificationsEnabled()) {
        promise.resolve(false)
        return
      }
      ensureChannel()
      val launch = reactContext.packageManager.getLaunchIntentForPackage(reactContext.packageName)
      val open = launch?.let {
        PendingIntent.getActivity(reactContext, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      }
      val builder = NotificationCompat.Builder(reactContext, CHANNEL_ID)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setSmallIcon(reactContext.applicationInfo.icon)
        .setAutoCancel(true)
        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      if (open != null) builder.setContentIntent(open)
      compat.notify(nextId.getAndIncrement(), builder.build())
      promise.resolve(true)
    } catch (e: SecurityException) {
      promise.resolve(false)
    } catch (e: Exception) {
      promise.reject("NOTIFY_ERROR", e.message, e)
    }
  }
}
