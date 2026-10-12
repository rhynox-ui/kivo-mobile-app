package com.kivo.chat

import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

class Pbkdf2Module(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = "Pbkdf2Module"
  @ReactMethod
  fun deriveSha256(password:String,saltBase64:String,iterations:Int,keyLengthBytes:Int,promise:Promise) {
    Thread {
      try {
        val salt=Base64.decode(saltBase64,Base64.NO_WRAP)
        val spec=PBEKeySpec(password.toCharArray(),salt,iterations,keyLengthBytes*8)
        val factory=SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        val keyBytes=factory.generateSecret(spec).encoded
        promise.resolve(Base64.encodeToString(keyBytes,Base64.NO_WRAP))
      } catch(e:Exception) { promise.reject("PBKDF2_ERROR",e.message,e) }
    }.start()
  }
}