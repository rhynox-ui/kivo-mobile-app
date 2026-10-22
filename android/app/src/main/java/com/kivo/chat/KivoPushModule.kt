package com.kivo.chat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Optional Firebase Messaging bridge. CI/dev builds without Firebase app config
 * still build normally and fail safe; configure KIVO_FCM_* Gradle environment
 * values in release builds to enable device token registration.
 */
class KivoPushModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "KivoPushModule"

  private fun ensureFirebaseApp(): FirebaseApp? {
    FirebaseApp.getApps(context).firstOrNull()?.let { return it }
    val projectId = BuildConfig.KIVO_FCM_PROJECT_ID
    val appId = BuildConfig.KIVO_FCM_APP_ID
    val apiKey = BuildConfig.KIVO_FCM_API_KEY
    val senderId = BuildConfig.KIVO_FCM_SENDER_ID
    if (projectId.isBlank() || appId.isBlank() || apiKey.isBlank() || senderId.isBlank()) return null
    val options = FirebaseOptions.Builder()
      .setProjectId(projectId)
      .setApplicationId(appId)
      .setApiKey(apiKey)
      .setGcmSenderId(senderId)
      .build()
    return FirebaseApp.initializeApp(context, options)
  }

  private fun ensureTradeChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel("trade-activity") == null) {
      manager.createNotificationChannel(NotificationChannel("trade-activity", "Followed trades", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "Trades from Kivo profiles you follow"
      })
    }
  }

  @ReactMethod
  fun getToken(promise: Promise) {
    try {
      val app = ensureFirebaseApp()
      if (app == null) {
        promise.reject("FCM_NOT_CONFIGURED", "Firebase Messaging is not configured for this build.")
        return
      }
      ensureTradeChannel()
      FirebaseMessaging.getInstance(app).token
        .addOnSuccessListener { token -> if (token.isNullOrBlank()) promise.reject("FCM_TOKEN_EMPTY", "Firebase returned an empty push token.") else promise.resolve(token) }
        .addOnFailureListener { error -> promise.reject("FCM_TOKEN_FAILED", error.message, error) }
    } catch (error: Exception) {
      promise.reject("FCM_NOT_READY", error.message, error)
    }
  }

  @ReactMethod
  fun getInitialTradeRoute(promise: Promise) {
    val activity = currentActivity
    val intent = activity?.intent
    val route = intent?.getStringExtra("route") ?: intent?.getStringExtra("href")
    if (route != null && (route.startsWith("kivo://trade") || route.startsWith("https://kivotrade.site/activity"))) {
      intent?.removeExtra("route")
      intent?.removeExtra("href")
      promise.resolve(route)
    } else {
      promise.resolve(null)
    }
  }
}
