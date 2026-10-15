package com.peartube.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.peartube.app.AppModel
import com.peartube.app.Screen
import com.peartube.app.player.PlayerHost

@Composable
fun App(model: AppModel, player: PlayerHost) {
    val screen by model.screen.collectAsState()
    val error by model.error.collectAsState()
    val settings by model.settings.collectAsState()

    // Back leaves Settings and the player; first-run Settings has nowhere to go back to.
    BackHandler(enabled = screen is Screen.Play || (screen == Screen.Settings && settings.tracker.isNotEmpty())) {
        model.screen.value = Screen.List
    }

    // The play screen paints its own background: the player's views are behind its slot.
    Column(Modifier.fillMaxSize().then(if (screen is Screen.Play) Modifier else Modifier.background(Bg))) {
        error?.let { message ->
            Row(
                Modifier.fillMaxWidth().background(Color(0xFF3A1D24)).padding(start = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(message, color = Ink, modifier = Modifier.weight(1f).padding(vertical = 10.dp))
                TextButton(onClick = { model.error.value = null }) { Text("×", color = Ink) }
            }
        }
        when (val current = screen) {
            Screen.List -> ListScreen(model)
            Screen.Settings -> SettingsScreen(model)
            is Screen.Play -> PlayScreen(model, player, current.entry)
        }
    }
}
