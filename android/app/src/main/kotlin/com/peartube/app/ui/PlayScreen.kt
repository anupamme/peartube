package com.peartube.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.peartube.app.AppModel
import com.peartube.app.Entry
import com.peartube.app.Screen
import com.peartube.app.formatBytes
import com.peartube.app.label
import com.peartube.app.player.NativePlayer
import com.peartube.app.player.PlayerHost
import com.peartube.app.player.PlayerState
import kotlinx.coroutines.delay
import java.io.File
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Plays [entry] through peartube-media's player. Its picture is native, drawn over the slot
 * below the header; the controls are here. Leaving the screen (back, or the end of the
 * video) closes it.
 */
@Composable
fun PlayScreen(model: AppModel, host: PlayerHost, entry: Entry) {
    val context = LocalContext.current
    var handle by remember { mutableLongStateOf(0L) }
    var openError by remember { mutableStateOf<String?>(null) }
    var state by remember { mutableStateOf(PlayerState()) }
    // The seek bar's position, in ms, while it is dragged.
    var dragging by remember { mutableStateOf<Float?>(null) }

    DisposableEffect(entry.streamUrl) {
        host.open()
        val soundfont = File(context.filesDir, "soundfont.sf2").takeIf { it.isFile }?.path
        val opened = try {
            NativePlayer.open(entry.streamUrl, soundfont)
        } catch (e: Throwable) {
            openError = "The player did not start: ${e.message ?: e}"
            0L
        }
        handle = opened
        onDispose {
            handle = 0L
            host.close()
            if (opened != 0L) NativePlayer.close(opened)
        }
    }

    // The worklet serving the stream suspends with the app; so does the player.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, handle) {
        val h = handle
        val observer = LifecycleEventObserver { _, event ->
            if (h == 0L) return@LifecycleEventObserver
            when (event) {
                Lifecycle.Event.ON_STOP -> NativePlayer.suspend(h)
                Lifecycle.Event.ON_START -> NativePlayer.resume(h)
                else -> {}
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    // Events come on change; the clock needs a steadier beat, so poll.
    LaunchedEffect(handle) {
        val h = handle
        if (h == 0L) return@LaunchedEffect
        var shape: Pair<Int, Int>? = null
        while (true) {
            val st = PlayerState.parse(NativePlayer.state(h))
            val w = st.videoWidth
            val ht = st.videoHeight
            if (w != null && ht != null && ht > 0 && (w to ht) != shape) {
                shape = w to ht
                host.fit(w.toFloat() / ht)
            }
            state = st
            if (st.ended) {
                model.screen.value = Screen.List
                break
            }
            delay(250)
        }
    }

    val audio = state.tracks.filter { it.kind == "audio" }
    val subtitles = state.tracks.filter { it.kind == "subtitle" }
    val length = state.durationMs ?: 0L
    val shown = dragging?.toLong() ?: state.positionMs
    val clockText = when {
        state.durationMs != null -> "${clock(shown)} / ${clock(length)}"
        state.buffering || state.positionMs == 0L -> "Loading…"
        else -> clock(state.positionMs)
    }
    val sha16 = entry.sha256.take(16)
    val origin = if (entry.local) "on this device" else "from peers"
    val maxSlot = (LocalConfiguration.current.screenHeightDp * 0.6f).dp

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(end = 16.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { model.screen.value = Screen.List }) { Text("←", fontSize = 22.sp, color = Ink) }
            Text("${entry.title} (${label(entry.id)})", color = Ink, fontSize = 17.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        HorizontalDivider(color = Line)
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            Box(
                Modifier.fillMaxWidth().height(min(maxWidth * 9f / 16f, maxSlot)).background(Color.Black)
                    .onGloballyPositioned {
                        val b = it.boundsInWindow()
                        host.place(b.left.roundToInt(), b.top.roundToInt(), b.width.roundToInt(), b.height.roundToInt())
                    },
            )
        }
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IconButton(
                enabled = handle != 0L,
                onClick = {
                    if (state.playing) NativePlayer.pause(handle) else NativePlayer.play(handle)
                    state = PlayerState.parse(NativePlayer.state(handle))
                },
            ) {
                Icon(if (state.playing) PauseIcon else PlayIcon, if (state.playing) "Pause" else "Play", tint = Ink)
            }
            Slider(
                value = shown.coerceIn(0L, length).toFloat(),
                valueRange = 0f..length.toFloat().coerceAtLeast(1f),
                enabled = length > 0,
                onValueChange = { dragging = it },
                onValueChangeFinished = {
                    dragging?.let { NativePlayer.seek(handle, it.toLong()) }
                    dragging = null
                },
                colors = SliderDefaults.colors(thumbColor = Brand, activeTrackColor = Brand, inactiveTrackColor = Line),
                modifier = Modifier.weight(1f),
            )
            Text(clockText, color = Dim, fontSize = 13.sp)
        }
        if (audio.size > 1 || subtitles.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (audio.size > 1) {
                    TrackMenu(
                        label = "Audio: ${audio.firstOrNull { it.stream == state.audio }?.label ?: "none"}",
                        options = audio.map { "Audio: ${it.label}" to it.stream },
                        modifier = Modifier.weight(1f),
                    ) { NativePlayer.selectAudio(handle, it) }
                }
                if (subtitles.isNotEmpty()) {
                    TrackMenu(
                        label = "Subtitles: ${subtitles.firstOrNull { it.stream == state.subtitle }?.label ?: "off"}",
                        options = listOf("Subtitles: off" to -1) + subtitles.map { "Subtitles: ${it.label}" to it.stream },
                        modifier = Modifier.weight(1f),
                    ) { NativePlayer.selectSubtitle(handle, it) }
                }
            }
        }
        (openError ?: state.error)?.let {
            Text(it, color = Danger, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        }
        Text("${formatBytes(entry.size)} · $sha16 · $origin", color = Dim, fontSize = 13.sp,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp))
    }
}

@Composable
private fun TrackMenu(label: String, options: List<Pair<String, Int>>, modifier: Modifier, onSelect: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
            Text(label, color = Ink, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { (text, stream) ->
                DropdownMenuItem(text = { Text(text) }, onClick = {
                    open = false
                    onSelect(stream)
                })
            }
        }
    }
}

private fun clock(ms: Long): String {
    val s = ms / 1000
    return if (s >= 3600) "%d:%02d:%02d".format(Locale.ROOT, s / 3600, s / 60 % 60, s % 60)
    else "%d:%02d".format(Locale.ROOT, s / 60, s % 60)
}
