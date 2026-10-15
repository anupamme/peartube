package com.peartube.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// The Dioxus app's main.css palette.
val Bg = Color(0xFF0F1115)
val CardBg = Color(0xFF171A21)
val Line = Color(0xFF262B36)
val Ink = Color(0xFFE6E8EE)
val Dim = Color(0xFF8A91A3)
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
            surfaceContainerHigh = CardBg,
            surfaceContainerHighest = CardBg,
            outline = Line,
            outlineVariant = Line,
            error = Danger,
        ),
        content = content,
    )
}
