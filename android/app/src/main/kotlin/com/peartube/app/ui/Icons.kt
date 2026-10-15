package com.peartube.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

// The player's icons, from Material Icons' path data (Apache-2.0). None of them are text:
// Android draws characters such as ⏸ as colour emoji whatever the variation selector.

val PlayIcon = icon("Play", "M8 5v14l11-7z")
val PauseIcon = icon("Pause", "M6 19h4V5H6v14zm8-14v14h4V5h-4z")
val BackIcon = icon("Back", "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z")
val ReplayIcon = icon("Replay", "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z")
val FullscreenIcon = icon("Fullscreen", "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z")
val FullscreenExitIcon = icon("Exit fullscreen", "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z")
val SubtitlesIcon = icon(
    "Subtitles",
    "M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z",
)
val AudioIcon = icon("Audio", "M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z")
val CheckIcon = icon("Selected", "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z")
val ExpandIcon = icon("Choose", "M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z")

private fun icon(name: String, path: String) =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        .addPath(addPathNodes(path), fill = SolidColor(Color.White))
        .build()
