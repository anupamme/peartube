package com.peartube.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Bg = Color(0xFF08090C)
val CardBg = Color(0xFF101218)
val CardElevated = Color(0xFF171A22)
val Line = Color(0xFF232733)
val Ink = Color(0xFFF2F4F8)
val Dim = Color(0xFF98A0B3)
val Accent = Color(0xFF45D08A)
val Brand = Color(0xFF9147FF)
val Danger = Color(0xFFFF7D7D)

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
