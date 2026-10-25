package com.peartube.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Bg = Color(0xFF0A0C10)
val CardBg = Color(0xFF131720)
val CardElevated = Color(0xFF1A202C)
val Line = Color(0xFF232A38)
val Ink = Color(0xFFF3F5FA)
val Dim = Color(0xFF8A93A6)
val Accent = Color(0xFF4ADE80)
val Brand = Color(0xFF9147FF)
val Danger = Color(0xFFFF6B6B)

@Composable
fun PearTubeTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Brand,
            onPrimary = Color.White,
            background = Bg,
            onBackground = Ink,
            surface = Bg,
            onSurface = Ink,
            surfaceVariant = CardBg,
            onSurfaceVariant = Dim,
            surfaceContainer = CardBg,
            surfaceContainerHigh = CardElevated,
            surfaceContainerHighest = CardElevated,
            outline = Line,
            outlineVariant = Line,
            error = Danger,
        ),
        content = content,
    )
}
