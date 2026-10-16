package com.peartube.app.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.SystemClock
import android.view.OrientationEventListener
import android.view.View
import android.view.WindowManager
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
import com.peartube.app.player.Track
import kotlinx.coroutines.delay
import java.io.File
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Plays [entry] through peartube-media's player. The picture is native, in views behind
 * this screen (PlayerHost); the screen leaves its slot clear and draws the controls over
 * it. They hide 3 s after the last touch while playing, and a tap on the picture brings
 * them back. Fullscreen fills the display, sideways for a wide picture; turning the phone
 * sideways enters it too. Leaving the screen (back, or the end of the video) closes it.
 */
@Composable
fun PlayScreen(model: AppModel, host: PlayerHost, entry: Entry) {
    val context = LocalContext.current
    val activity = remember(context) { context.activity() }
    val view = LocalView.current
    var handle by remember { mutableLongStateOf(0L) }
    var openError by remember { mutableStateOf<String?>(null) }
    var state by remember { mutableStateOf(PlayerState()) }
    // Where the seek bar is dragged to, or a seek the player has not reached yet.
    var target by remember { mutableStateOf<Long?>(null) }
    var seekedAt by remember { mutableLongStateOf(0L) }
    var scrubbing by remember { mutableStateOf(false) }
    var controls by remember { mutableStateOf(true) }
    var touches by remember { mutableIntStateOf(0) }
    var menuOpen by remember { mutableStateOf(false) }
    var wantFullscreen by remember { mutableStateOf(false) }
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val fullscreen = wantFullscreen || landscape

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
            // A seek is done once the player is near it; it may land on an earlier keyframe.
            target?.let {
                if (!scrubbing && (abs(st.positionMs - it) < 1_500 || SystemClock.uptimeMillis() - seekedAt > 2_000)) target = null
            }
            if (st.ended) {
                model.screen.value = Screen.List
                break
            }
            delay(250)
        }
    }

    LaunchedEffect(controls, state.playing, touches, scrubbing, menuOpen) {
        if (controls && state.playing && !scrubbing && !menuOpen) {
            delay(3_000)
            controls = false
        }
    }

    LaunchedEffect(fullscreen) { activity.immersive(fullscreen, view) }
    DisposableEffect(activity) {
        // Leaving fullscreen by hand while sideways locks portrait (setFullscreen); once the
        // phone is upright again, the sensor chooses again.
        val upright = object : OrientationEventListener(activity) {
            override fun onOrientationChanged(degrees: Int) {
                if (degrees != ORIENTATION_UNKNOWN && (degrees < 20 || degrees > 340) &&
                    activity.requestedOrientation == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                ) {
                    activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                }
            }
        }
        upright.enable()
        onDispose {
            upright.disable()
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            activity.immersive(false, view)
        }
    }

    val length = state.durationMs ?: 0L
    val shown = target ?: state.positionMs
    val error = openError ?: state.error
    val busy = handle != 0L && state.buffering && error == null
    val wide = state.videoWidth?.let { w -> state.videoHeight?.let { h -> w >= h } } ?: true

    fun show() {
        controls = true
        touches++
    }
    fun setFullscreen(on: Boolean) {
        show()
        wantFullscreen = on
        activity.requestedOrientation = when {
            on && wide -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            on -> activity.requestedOrientation
            landscape -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }
    fun playPause() {
        show()
        if (handle == 0L) return
        if (state.playing) NativePlayer.pause(handle) else NativePlayer.play(handle)
        state = PlayerState.parse(NativePlayer.state(handle))
    }
    fun seekTo(ms: Long) {
        show()
        if (handle == 0L || length <= 0) return
        val to = ms.coerceIn(0L, length)
        target = to
        seekedAt = SystemClock.uptimeMillis()
        NativePlayer.seek(handle, to)
    }
    BackHandler(enabled = fullscreen) { setFullscreen(false) }

    val audio = state.tracks.filter { it.kind == "audio" }
    val subtitles = state.tracks.filter { it.kind == "subtitle" }
    val audioOptions = if (audio.size > 1) audio.map { Option(it.label, it.stream, it.stream == state.audio) } else emptyList()
    val subtitleOptions = if (subtitles.isEmpty()) emptyList() else {
        listOf(Option("Off", -1, subtitles.none { it.stream == state.subtitle })) +
            subtitles.map { Option(it.label, it.stream, it.stream == state.subtitle) }
    }
    val selectAudio: (Int) -> Unit = { if (handle != 0L) NativePlayer.selectAudio(handle, it) }
    val selectSubtitle: (Int) -> Unit = { if (handle != 0L) NativePlayer.selectSubtitle(handle, it) }
    val clockText = when {
        state.durationMs != null -> "${clock(shown)} / ${clock(length)}"
        state.buffering || state.positionMs == 0L -> "Loading…"
        else -> clock(state.positionMs)
    }

    val overlay: @Composable () -> Unit = {
        Box(
            Modifier.fillMaxSize()
                // The clock as well, for TalkBack and for android/e2e.mjs: the controls hide.
                .semantics { contentDescription = "Video, $clockText" }
                .pointerInput(Unit) {
                    detectTapGestures {
                        controls = !controls
                        touches++
                    }
                },
        ) {
            AnimatedVisibility(controls || !state.playing, enter = fadeIn(), exit = fadeOut()) {
                Box(Modifier.fillMaxSize().background(Scrim)) {
                    // Only fullscreen lays out past the cutout. Out of it, the window fits the
                    // system bars, and a cutout inset left over from fullscreen pushed this row
                    // down by about the status bar's height.
                    Row(
                        Modifier.align(Alignment.TopStart).fillMaxWidth()
                            .then(if (fullscreen) Modifier.windowInsetsPadding(WindowInsets.displayCutout) else Modifier)
                            .padding(horizontal = if (fullscreen) 16.dp else 4.dp, vertical = if (fullscreen) 8.dp else 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        OverlayButton(BackIcon, "Back", { if (fullscreen) setFullscreen(false) else model.screen.value = Screen.List })
                        if (fullscreen) {
                            Text(
                                entry.title, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold,
                                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 8.dp),
                            )
                            if (subtitleOptions.isNotEmpty()) {
                                TrackPicker(subtitleOptions, selectSubtitle, { menuOpen = it }) { open -> OverlayButton(SubtitlesIcon, "Subtitles", open) }
                            }
                            if (audioOptions.isNotEmpty()) {
                                TrackPicker(audioOptions, selectAudio, { menuOpen = it }) { open -> OverlayButton(AudioIcon, "Audio", open) }
                            }
                        }
                    }
                    Row(
                        Modifier.align(Alignment.Center),
                        horizontalArrangement = Arrangement.spacedBy(if (fullscreen) 56.dp else 36.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        OverlayButton(ReplayIcon, "Back 10 seconds", { seekTo(shown - 10_000) }, size = 52.dp, iconSize = 34.dp, badge = "10")
                        if (busy) {
                            Spacer(Modifier.size(64.dp))
                        } else {
                            OverlayButton(
                                if (state.playing) PauseIcon else PlayIcon, if (state.playing) "Pause" else "Play", ::playPause,
                                size = 64.dp, iconSize = 38.dp, filled = true,
                            )
                        }
                        OverlayButton(ReplayIcon, "Forward 10 seconds", { seekTo(shown + 10_000) }, size = 52.dp, iconSize = 34.dp, badge = "10", mirrored = true)
                    }
                    Column(
                        Modifier.align(Alignment.BottomCenter).fillMaxWidth().windowInsetsPadding(WindowInsets.displayCutout)
                            .padding(horizontal = if (fullscreen) 24.dp else 12.dp)
                            .padding(bottom = if (fullscreen) 16.dp else 2.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(clockText, color = Color.White, fontSize = 13.sp, modifier = Modifier.weight(1f).padding(start = 4.dp))
                            OverlayButton(
                                if (fullscreen) FullscreenExitIcon else FullscreenIcon,
                                if (fullscreen) "Exit fullscreen" else "Fullscreen",
                                { setFullscreen(!fullscreen) },
                            )
                        }
                        SeekBar(
                            fraction = if (length > 0) shown.toFloat() / length else 0f,
                            enabled = handle != 0L && length > 0,
                            onScrub = {
                                scrubbing = true
                                controls = true
                                target = (it.coerceIn(0f, 1f) * length).toLong()
                            },
                            onRelease = {
                                scrubbing = false
                                target?.let(::seekTo)
                            },
                        )
                    }
                }
            }
            if (busy) {
                CircularProgressIndicator(Modifier.align(Alignment.Center).size(48.dp), color = Color.White, strokeWidth = 3.dp)
            }
        }
    }

    if (fullscreen) {
        Box(Modifier.fillMaxSize()) {
            Slot(host, Modifier.fillMaxSize())
            overlay()
        }
    } else {
        val maxSlot = (LocalConfiguration.current.screenHeightDp * 0.6f).dp
        Column(Modifier.fillMaxSize()) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                Box(Modifier.fillMaxWidth().height(min(maxWidth * 9f / 16f, maxSlot))) {
                    Slot(host, Modifier.fillMaxSize())
                    overlay()
                }
            }
            Column(
                Modifier.fillMaxSize().background(Bg).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 14.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(entry.title, color = Ink, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, lineHeight = 26.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    "${label(entry.id)} · ${formatBytes(entry.size)} · ${if (entry.local) "on this device" else "from peers"}",
                    color = Dim, fontSize = 13.sp,
                )
                if (audioOptions.isNotEmpty() || subtitleOptions.isNotEmpty()) {
                    Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (audioOptions.isNotEmpty()) {
                            TrackPicker(audioOptions, selectAudio, { menuOpen = it }) { open ->
                                Chip(AudioIcon, audio.firstOrNull { it.stream == state.audio }?.let(::shortName) ?: "No audio", open)
                            }
                        }
                        if (subtitleOptions.isNotEmpty()) {
                            TrackPicker(subtitleOptions, selectSubtitle, { menuOpen = it }) { open ->
                                Chip(SubtitlesIcon, subtitles.firstOrNull { it.stream == state.subtitle }?.let(::shortName) ?: "Off", open)
                            }
                        }
                    }
                }
                error?.let {
                    Text(
                        it, color = Danger, fontSize = 14.sp,
                        modifier = Modifier.padding(top = 14.dp).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(CardBg).padding(12.dp),
                    )
                }
                Text("SHA-256 ${entry.sha256.take(16)}…", color = Dim, fontSize = 11.sp, modifier = Modifier.padding(top = 18.dp))
            }
        }
    }
}

// Darker at the edges, where the buttons and the clock are.
private val Scrim = Brush.verticalGradient(
    0f to Color.Black.copy(alpha = 0.6f),
    0.3f to Color.Black.copy(alpha = 0.15f),
    0.6f to Color.Black.copy(alpha = 0.15f),
    1f to Color.Black.copy(alpha = 0.75f),
)

/** Where the native picture goes: PlayerHost keeps its views over this box. */
@Composable
private fun Slot(host: PlayerHost, modifier: Modifier) {
    Box(
        modifier.onGloballyPositioned {
            val b = it.boundsInWindow()
            host.place(b.left.roundToInt(), b.top.roundToInt(), b.width.roundToInt(), b.height.roundToInt())
        },
    )
}

@Composable
private fun OverlayButton(
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
    size: Dp = 48.dp,
    iconSize: Dp = 26.dp,
    filled: Boolean = false,
    badge: String? = null,
    mirrored: Boolean = false,
) {
    Box(
        Modifier.size(size).clip(CircleShape)
            .background(if (filled) Color.Black.copy(alpha = 0.45f) else Color.Transparent)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, description, tint = Color.White, modifier = Modifier.size(iconSize).graphicsLayer { if (mirrored) scaleX = -1f })
        // The replay arrow's circle sits a little below the middle of its box.
        badge?.let { Text(it, color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 4.dp)) }
    }
}

/** A thin bar, thicker under the finger: tap or drag to seek. [fraction] is the position. */
@Composable
private fun SeekBar(fraction: Float, enabled: Boolean, onScrub: (Float) -> Unit, onRelease: () -> Unit) {
    val scrub by rememberUpdatedState(onScrub)
    val release by rememberUpdatedState(onRelease)
    var active by remember { mutableStateOf(false) }
    Canvas(
        Modifier.fillMaxWidth().height(28.dp)
            .semantics { contentDescription = "Seek" }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures {
                    scrub(it.x / size.width)
                    release()
                }
            }
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectHorizontalDragGestures(
                    onDragStart = {
                        active = true
                        scrub(it.x / size.width)
                    },
                    onDragEnd = {
                        active = false
                        release()
                    },
                    onDragCancel = {
                        active = false
                        release()
                    },
                ) { change, _ ->
                    change.consume()
                    scrub(change.position.x / size.width)
                }
            },
    ) {
        val y = size.height / 2
        val x = size.width * fraction.coerceIn(0f, 1f)
        val stroke = (if (active) 5.dp else 3.dp).toPx()
        drawLine(Color.White.copy(alpha = 0.35f), Offset(0f, y), Offset(size.width, y), stroke, StrokeCap.Round)
        drawLine(Brand, Offset(0f, y), Offset(x, y), stroke, StrokeCap.Round)
        if (enabled) drawCircle(Brand, (if (active) 9.dp else 6.dp).toPx(), Offset(x, y))
    }
}

private data class Option(val label: String, val stream: Int, val selected: Boolean)

/** A menu of tracks, opened from [anchor]; the current one is ticked. */
@Composable
private fun TrackPicker(options: List<Option>, onSelect: (Int) -> Unit, onOpen: (Boolean) -> Unit, anchor: @Composable (open: () -> Unit) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val notify by rememberUpdatedState(onOpen)
    val set = { value: Boolean ->
        open = value
        notify(value)
    }
    // Turning the phone swaps the chips below the picture for the fullscreen top bar; a picker
    // that leaves with its menu up must not keep the controls from hiding.
    DisposableEffect(Unit) { onDispose { if (open) notify(false) } }
    Box {
        anchor { set(true) }
        DropdownMenu(expanded = open, onDismissRequest = { set(false) }) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.label, color = Ink) },
                    leadingIcon = {
                        if (option.selected) Icon(CheckIcon, "Selected", tint = Brand) else Spacer(Modifier.size(24.dp))
                    },
                    onClick = {
                        set(false)
                        onSelect(option.stream)
                    },
                )
            }
        }
    }
}

@Composable
private fun Chip(icon: ImageVector, text: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(18.dp)
    Row(
        Modifier.clip(shape).background(CardBg).border(1.dp, Line, shape).clickable(onClick = onClick)
            .padding(start = 12.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, null, tint = Dim, modifier = Modifier.size(18.dp))
        Text(text, color = Ink, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 150.dp))
        Icon(ExpandIcon, null, tint = Dim, modifier = Modifier.size(18.dp))
    }
}

/** A track's name without its codec: its title, else its language. */
private fun shortName(track: Track) = track.title ?: track.language?.uppercase(Locale.ROOT) ?: "Track ${track.stream}"

private fun clock(ms: Long): String {
    val s = ms.coerceAtLeast(0L) / 1000
    return if (s >= 3600) "%d:%02d:%02d".format(Locale.ROOT, s / 3600, s / 60 % 60, s % 60)
    else "%d:%02d".format(Locale.ROOT, s / 60, s % 60)
}

/**
 * Fullscreen hides the system bars and lays the window out edge to edge, past the camera
 * cutout: the picture centres on the whole display, and the controls pad themselves clear
 * of the cutout.
 */
private fun Activity.immersive(on: Boolean, view: View) {
    WindowCompat.setDecorFitsSystemWindows(window, !on)
    val bars = WindowCompat.getInsetsController(window, view)
    if (on) {
        bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        bars.hide(WindowInsetsCompat.Type.systemBars())
    } else {
        bars.show(WindowInsetsCompat.Type.systemBars())
    }
    window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = if (on) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
    }
}

private tailrec fun Context.activity(): Activity = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> error("The play screen needs an activity")
}
