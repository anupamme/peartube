package com.peartube.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import com.peartube.app.player.PlayerHost
import com.peartube.app.ui.App
import com.peartube.app.ui.PearTubeTheme

class MainActivity : ComponentActivity() {
    private lateinit var player: PlayerHost

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val model = (application as PearTubeApp).model
        if (savedInstanceState == null) {
            intent?.dataString?.let(model::openUriOrKey)
        }
        player = PlayerHost(this)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
        )
        setContent { PearTubeTheme { App(model, player) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val model = (application as PearTubeApp).model
        intent.dataString?.let(model::openUriOrKey)
    }

    override fun onDestroy() {
        player.destroy()
        super.onDestroy()
    }
}
