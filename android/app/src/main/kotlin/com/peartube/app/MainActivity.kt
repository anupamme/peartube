package com.peartube.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.peartube.app.player.PlayerHost
import com.peartube.app.ui.App
import com.peartube.app.ui.PearTubeTheme

class MainActivity : ComponentActivity() {
    private lateinit var player: PlayerHost

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val model = (application as PearTubeApp).model
        player = PlayerHost(this)
        setContent { PearTubeTheme { App(model, player) } }
    }

    override fun onDestroy() {
        player.destroy()
        super.onDestroy()
    }
}
