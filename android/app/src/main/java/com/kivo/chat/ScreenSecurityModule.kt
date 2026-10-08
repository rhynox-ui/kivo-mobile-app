package com.kivo.chat

import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class ScreenSecurityModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = "ScreenSecurityModule"
  @ReactMethod fun setSecure(secure: Boolean, promise: Promise) {
    val activity = reactApplicationContext.currentActivity ?: run { promise.resolve(false); return }
    activity.runOnUiThread { if (secure) activity.window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE) else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    promise.resolve(true)
  }
}