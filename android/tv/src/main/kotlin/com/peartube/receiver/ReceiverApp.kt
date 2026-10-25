package com.peartube.receiver

import android.app.Application
import android.net.wifi.WifiManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Dedicated Dumb TV Receiver application (`com.peartube.receiver`):
 * holds strong references to Wi-Fi multicast, low-latency radio, and CPU partial wake locks
 * so Kotlin GC never drops them while waiting for or playing an incoming cast.
 */
class ReceiverApp : Application() {
    lateinit var worker: ReceiverWorker
        private set
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var multicastLock: WifiManager.MulticastLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var cpuWakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        worker = ReceiverWorker(this)
        val tvName = Build.MODEL?.takeIf { it.isNotBlank() }?.let { "PearTube TV · $it" } ?: "PearTube TV"
        appScope.launch {
            runCatching { worker.ensureStarted(tvName, openAuth = true) }
            // Catch USB 3.0 SSDs that finish vold mounting a few seconds after Android TV boot.
            for (waitMs in listOf(5_000L, 15_000L)) {
                delay(waitMs)
                runCatching { worker.ensureStarted(tvName, openAuth = true, forceRefreshStorage = true) }
            }
        }
        val mediaFilter = IntentFilter().apply {
            addAction(Intent.ACTION_MEDIA_MOUNTED)
            addAction(Intent.ACTION_MEDIA_UNMOUNTED)
            addAction(Intent.ACTION_MEDIA_EJECT)
            addDataScheme("file")
        }
        val mediaReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                appScope.launch {
                    delay(1200)
                    runCatching { worker.ensureStarted(tvName, openAuth = true, forceRefreshStorage = true) }
                }
            }
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(mediaReceiver, mediaFilter, RECEIVER_EXPORTED)
        else registerReceiver(mediaReceiver, mediaFilter)
        val wifi = getSystemService(WifiManager::class.java)
        multicastLock = wifi.createMulticastLock("PearTube TV mDNS").apply {
            setReferenceCounted(false)
            acquire()
        }
        wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "PearTube TV stream").apply {
            setReferenceCounted(false)
            acquire()
        }
        cpuWakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "peartube:receiver")
            .apply {
                setReferenceCounted(false)
                acquire()
            }
    }
}
