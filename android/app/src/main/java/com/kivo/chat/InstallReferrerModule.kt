package com.kivo.chat

import android.os.Handler
import android.os.Looper
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Reads the Google Play install referrer (e.g. "ref=alice" from a Kivo
 * referral link) so sign-up can pre-fill "Who referred you?". Resolves the raw
 * referrer string, or null on any error, timeout or missing Play Store. Never
 * rejects: a referral is optional and must never break the app.
 */
class InstallReferrerModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = "InstallReferrerModule"

  @ReactMethod
  fun getInstallReferrer(promise: Promise) {
    val done = AtomicBoolean(false)
    var client: InstallReferrerClient? = null
    fun finish(value: String?) {
      if (!done.compareAndSet(false, true)) return
      try { client?.endConnection() } catch (ignored: Throwable) {}
      try { promise.resolve(value) } catch (ignored: Throwable) {}
    }
    try {
      val c = InstallReferrerClient.newBuilder(reactContext.applicationContext).build()
      client = c
      Handler(Looper.getMainLooper()).postDelayed({ finish(null) }, 10_000L)
      c.startConnection(object : InstallReferrerStateListener {
        override fun onInstallReferrerSetupFinished(responseCode: Int) {
          if (responseCode != InstallReferrerClient.InstallReferrerResponse.OK) { finish(null); return }
          val referrer = try { c.installReferrer?.installReferrer } catch (ignored: Throwable) { null }
          finish(referrer)
        }

        override fun onInstallReferrerServiceDisconnected() {
          finish(null)
        }
      })
    } catch (ignored: Throwable) {
      finish(null)
    }
  }
}
