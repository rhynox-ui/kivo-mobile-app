package com.kivo.chat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging

/** Optional FCM bridge; builds without configured Firebase values remain functional. */
class KivoPushModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  companion object {
    @Volatile private var activeContext: ReactApplicationContext? = null
    fun emitTradeRoute(intent: Intent) {
      val route = intent.getStringExtra("route") ?: intent.getStringExtra("href") ?: return
      if (!route.startsWith("kivo://trade") && !route.startsWith("https://kivotrade.site/activity")) return
      val reactContext = activeContext ?: return
      runCatching {
        if (reactContext.hasActiveReactInstance()) {
          reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("KivoTradePushOpened", route)
        }
      }
    }
  }
  init { activeContext = context }
  override fun getName() = "KivoPushModule"
  @ReactMethod fun addListener(eventName: String) { /* Required by NativeEventEmitter. */ }
  @ReactMethod fun removeListeners(count: Int) { /* Required by NativeEventEmitter. */ }

  private fun ensureFirebaseApp(): FirebaseApp? {
    FirebaseApp.getApps(context).firstOrNull()?.let { return it }
    val projectId = BuildConfig.KIVO_FCM_PROJECT_ID
    val appId = BuildConfig.KIVO_FCM_APP_ID
    val apiKey = BuildConfig.KIVO_FCM_API_KEY
    val senderId = BuildConfig.KIVO_FCM_SENDER_ID
    if (projectId.isBlank() || appId.isBlank() || apiKey.isBlank() || senderId.isBlank()) return null
    return FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
      .setProjectId(projectId).setApplicationId(appId).setApiKey(apiKey).setGcmSenderId(senderId).build())
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

  @ReactMethod fun getToken(promise: Promise) {
    try {
      val app = ensureFirebaseApp()
      if (app == null) { promise.reject("FCM_NOT_CONFIGURED", "Firebase Messaging is not configured for this build."); return }
      ensureTradeChannel()
      FirebaseMessaging.getInstance(app).token
        .addOnSuccessListener { token -> if (token.isNullOrBlank()) promise.reject("FCM_TOKEN_EMPTY", "Firebase returned an empty push token.") else promise.resolve(token) }
        .addOnFailureListener { error -> promise.reject("FCM_TOKEN_FAILED", error.message, error) }
    } catch (error: Exception) { promise.reject("FCM_NOT_READY", error.message, error) }
  }

  @ReactMethod fun getInitialTradeRoute(promise: Promise) {
    val intent = currentActivity?.intent
    val route = intent?.getStringExtra("route") ?: intent?.getStringExtra("href")
    if (route != null && (route.startsWith("kivo://trade") || route.startsWith("https://kivotrade.site/activity"))) {
      intent?.removeExtra("route"); intent?.removeExtra("href"); promise.resolve(route)
    } else promise.resolve(null)
  }
}
