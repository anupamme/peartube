package com.peartube.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

// Android draws the ⏸ character as a colour emoji whatever the variation selector, so the
// player's two buttons are drawn here instead.

val PlayIcon: ImageVector = icon("Play") {
    moveTo(8f, 5f)
    lineTo(19f, 12f)
    lineTo(8f, 19f)
    close()
}

val PauseIcon: ImageVector = icon("Pause") {
    moveTo(6f, 5f)
    lineTo(10f, 5f)
    lineTo(10f, 19f)
    lineTo(6f, 19f)
    close()
    moveTo(14f, 5f)
    lineTo(18f, 5f)
    lineTo(18f, 19f)
    lineTo(14f, 19f)
    close()
}

private fun icon(name: String, draw: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit) =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        .apply { path(fill = SolidColor(Color.White), pathBuilder = draw) }
        .build()
