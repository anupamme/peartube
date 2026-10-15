package com.peartube.app

import android.app.Application
import android.net.wifi.WifiManager
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

class PearTubeApp : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        model = AppModel(this)
        // LAN discovery's mDNS needs the multicast lock while the app is in front.
        val multicast = getSystemService(WifiManager::class.java)
            .createMulticastLock("PearTube LAN discovery")
            .apply { setReferenceCounted(false) }
        // The worklet's I/O stops while the app is in the background.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                multicast.acquire()
                model.worker.resume()
            }

            override fun onStop(owner: LifecycleOwner) {
                model.worker.suspend()
                multicast.release()
            }
        })
    }
}
