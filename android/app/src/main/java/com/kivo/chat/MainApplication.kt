package com.kivo.chat

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions

class MainApplication : Application(), ReactApplication {
  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList = PackageList(this).packages.apply {
        add(Pbkdf2Package())
        add(ScreenSecurityPackage())
        add(LocalNotifyPackage())
        add(MediaSavePackage())
        add(InstallReferrerPackage())
        add(KivoPushPackage())
      },
    )
  }
  override fun onCreate() {
    super.onCreate()
    if (FirebaseApp.getApps(this).isEmpty() &&
      BuildConfig.KIVO_FCM_PROJECT_ID.isNotBlank() &&
      BuildConfig.KIVO_FCM_APP_ID.isNotBlank() &&
      BuildConfig.KIVO_FCM_API_KEY.isNotBlank() &&
      BuildConfig.KIVO_FCM_SENDER_ID.isNotBlank()) {
      FirebaseApp.initializeApp(this, FirebaseOptions.Builder()
        .setProjectId(BuildConfig.KIVO_FCM_PROJECT_ID)
        .setApplicationId(BuildConfig.KIVO_FCM_APP_ID)
        .setApiKey(BuildConfig.KIVO_FCM_API_KEY)
        .setGcmSenderId(BuildConfig.KIVO_FCM_SENDER_ID)
        .build())
    }
    loadReactNative(this)
  }
}