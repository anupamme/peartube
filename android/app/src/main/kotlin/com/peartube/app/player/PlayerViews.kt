package com.peartube.app.player

import android.app.Activity
import android.app.UiModeManager
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.Toast
import kotlin.math.abs
import kotlin.math.roundToInt

/** The longest surfaceDestroyed waits for the native side to let go of its Surface. */
private const val RELEASE_WAIT_MS = 1_000L

/**
 * The surfaces the player draws on: video, and subtitles above it. They sit behind the
 * Compose UI, in the activity's content view rather than inside Compose, under the play
 * screen's slot, which the screen leaves clear and draws its controls over. Old views stay
 * attached until the native side proves it has let go of their surfaces, which can outlast
 * the screen; other screens cover them. The video view takes the picture's shape inside the
 * slot (black bars around it); the subtitle view covers the whole slot. Ported from the
 * Dioxus app's MainActivity. UI thread only.
 */
class PlayerHost(private val activity: Activity) {
    private val handler = Handler(Looper.getMainLooper())
    private var views: PlayerViews? = null
    private var wanted = false
    private var destroyed = false
    private val frame = IntArray(4)
    private var hasFrame = false
    private var aspect = 0f
    private var frameRate = 0f
    private var appliedModeId = 0
    private var closeStarted = 0L
    private var closeReported = false
    private val retirementPoll = Runnable { advance() }

    /** Requests fresh views; old ones stay attached until native retirement is proved. */
    fun open() {
        if (destroyed) return
        wanted = true
        aspect = 0f
        frameRate = 0f
        beginRetirement()
        advance()
    }

    /** Moves the views over [left, top, width, height] in window pixels. */
    fun place(left: Int, top: Int, width: Int, height: Int) {
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        val origin = IntArray(2).also { content.getLocationInWindow(it) }
        val nextLeft = left - origin[0]
        val nextTop = top - origin[1]
        // Never poke Android's layout pass unless the slot truly moved, so SurfaceFlinger stays locked on its hardware plane.
        if (hasFrame && frame[0] == nextLeft && frame[1] == nextTop && frame[2] == width && frame[3] == height) return
        frame[0] = nextLeft
        frame[1] = nextTop
        frame[2] = width
        frame[3] = height
        hasFrame = true
        views?.takeUnless { it.closing }?.place(frame)
    }

    /** The picture's width over its height. */
    fun fit(aspect: Float) {
        if (kotlin.math.abs(this.aspect - aspect) < 0.0005f) return
        this.aspect = aspect
        views?.takeUnless { it.closing }?.fit(aspect)
    }

    /** Locks HDMI / panel VSYNC onto the stream's exact cadence (e.g. 3840x2160 @ 23.976 Hz) so 30 Hz never strobes 24p film. */
    fun matchFrameRate(fps: Float) {
        if (fps < 1f || fps > 240f || abs(this.frameRate - fps) < 0.005f) return
        this.frameRate = fps
        views?.takeUnless { it.closing }?.setSurfaceFrameRate(fps)
        val isTv = activity.getSystemService(UiModeManager::class.java)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
        if (!isTv) return
        val display: Display = if (Build.VERSION.SDK_INT >= 30) (activity.display ?: return) else @Suppress("DEPRECATION") activity.windowManager.defaultDisplay
        val active = display.mode ?: return
        val modes = display.supportedModes ?: return
        val targetW = if (active.physicalWidth == 4096 && active.physicalHeight == 2160 && modes.any { it.physicalWidth == 3840 && it.physicalHeight == 2160 }) 3840 else active.physicalWidth
        val sameRes = modes.filter { it.physicalWidth == targetW && it.physicalHeight == active.physicalHeight }
        var best = sameRes.minByOrNull { m ->
            val r = m.refreshRate
            val k = (r / fps).roundToInt().coerceAtLeast(1)
            val multErr = abs(r - fps * k) / k
            if (abs(r - fps) <= 0.03f) abs(r - fps) else if (multErr <= 0.03f) 0.05f + multErr else 100f + abs(r - fps)
        }?.takeIf { m ->
            val k = (m.refreshRate / fps).roundToInt().coerceAtLeast(1)
            abs(m.refreshRate - fps * k) / k <= 0.03f
        }
        // If 4K HDMI only reaches 30 Hz (HDMI 1.4 / Pi 4 default) and a 50/60p stream arrives, step down to 1080p60 so motion stays silk.
        if (best == null && fps >= 47f && active.refreshRate < 47f) {
            best = modes
                .filter { it.physicalWidth == 1920 && it.physicalHeight == 1080 }
                .minByOrNull { abs(it.refreshRate - fps) }
                ?.takeIf { abs(it.refreshRate - fps) <= 0.5f }
        }
        if (best != null && best.modeId != active.modeId && best.modeId != appliedModeId) {
            appliedModeId = best.modeId
            activity.window.attributes = activity.window.attributes.apply { preferredDisplayModeId = best.modeId }
        }
    }

    private fun restoreDisplayMode() {
        frameRate = 0f
        if (appliedModeId != 0) {
            appliedModeId = 0
            runCatching {
                activity.window.attributes = activity.window.attributes.apply { preferredDisplayModeId = 0 }
            }
        }
    }

    /** Requests close without blocking the UI on native calls. */
    fun close() {
        wanted = false
        hasFrame = false
        restoreDisplayMode()
        beginRetirement()
        advance()
    }

    fun destroy() {
        destroyed = true
        wanted = false
        restoreDisplayMode()
        handler.removeCallbacks(retirementPoll)
        // Framework destruction cannot wait for a stalled native call. Publish
        // invalidation and report pending cleanup; do not invent a receipt.
        views?.destroyWithActivity()
        views = null
    }

    internal fun failure(message: String) {
        Log.e("PearTubePlayer", message)
        if (!destroyed) Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
    }

    private fun beginRetirement() {
        val current = views ?: return
        if (!current.closing) {
            closeStarted = SystemClock.uptimeMillis()
            closeReported = false
            current.beginRetirement()
        }
    }

    private fun advance() {
        handler.removeCallbacks(retirementPoll)
        if (destroyed) return
        val current = views
        if (current != null && current.closing) {
            val status = current.retirementStatus()
            if (status != 1) {
                val overdue = SystemClock.uptimeMillis() - closeStarted >= 5_000L
                if (!closeReported && (status == 2 || overdue)) {
                    closeReported = true
                    failure("Player Surface cleanup is ${if (status == 2) "unproved" else "still pending"}; replacement is held.")
                }
                // One coalesced observation, never another native owner.
                handler.postDelayed(retirementPoll, if (closeReported) 1_000L else 50L)
                return
            }
            current.removeRetired()
            views = null
        }
        if (views == null && wanted) {
            views = PlayerViews(activity, this, handler).also {
                it.fit(aspect)
                if (frameRate > 0f) it.setSurfaceFrameRate(frameRate)
                if (hasFrame) it.place(frame)
            }
        }
    }
}

private class PlayerViews(activity: Activity, host: PlayerHost, handler: Handler) {
    private val root = FrameLayout(activity)
    private val video = SurfaceView(activity)
    private val videoCallback = SurfaceCallback(host, handler, 1)
    private val subtitleCallback = SurfaceCallback(host, handler, 2)

    // The slot's size, and the picture's width over its height (0: unknown, fill the slot).
    private var slotWidth = 0
    private var slotHeight = 0
    private var aspect = 0f
    private var appliedLeft = Int.MIN_VALUE
    private var appliedTop = Int.MIN_VALUE
    private var appliedVideoW = Int.MIN_VALUE
    private var appliedVideoH = Int.MIN_VALUE
    private var appliedVideoGravity = Int.MIN_VALUE
    var closing = false
        private set

    init {
        video.holder.addCallback(videoCallback)
        val subtitles = SurfaceView(activity)
        subtitles.setZOrderMediaOverlay(true)
        subtitles.holder.setFormat(PixelFormat.TRANSLUCENT)
        subtitles.holder.addCallback(subtitleCallback)
        val fill = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        root.setBackgroundColor(Color.BLACK)
        root.addView(video, FrameLayout.LayoutParams(fill))
        root.addView(subtitles, fill)
        root.keepScreenOn = true
        // Invisible views get no surface: none exists until the screen reports its slot.
        root.visibility = View.INVISIBLE
        activity.findViewById<ViewGroup>(android.R.id.content).addView(root, 0, FrameLayout.LayoutParams(0, 0))
    }

    fun place(rect: IntArray) {
        if (closing) return
        if (appliedLeft != rect[0] || appliedTop != rect[1] || slotWidth != rect[2] || slotHeight != rect[3]) {
            appliedLeft = rect[0]
            appliedTop = rect[1]
            slotWidth = rect[2]
            slotHeight = rect[3]
            root.layoutParams = FrameLayout.LayoutParams(rect[2], rect[3]).apply {
                leftMargin = rect[0]
                topMargin = rect[1]
            }
            layoutVideo()
        }
        if (root.visibility != View.VISIBLE) root.visibility = View.VISIBLE
    }

    fun fit(aspect: Float) {
        if (closing || abs(this.aspect - aspect) < 0.0005f) return
        this.aspect = aspect
        layoutVideo()
    }

    fun setSurfaceFrameRate(fps: Float) {
        if (closing) return
        videoCallback.setDesiredFrameRate(fps)
    }

    // The largest rect of the picture's shape inside the slot, centred.
    // Resizing the view keeps its surface; only surfaceChanged follows.
    private fun layoutVideo() {
        val (w, h) = slotWidth to slotHeight
        val (targetW, targetH, gravity) = when {
            aspect <= 0f || w <= 0 || h <= 0 ->
                Triple(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.NO_GRAVITY)
            w > h * aspect -> Triple(Math.round(h * aspect), h, Gravity.CENTER)
            else -> Triple(w, Math.round(w / aspect), Gravity.CENTER)
        }
        if (targetW == appliedVideoW && targetH == appliedVideoH && gravity == appliedVideoGravity) return
        appliedVideoW = targetW
        appliedVideoH = targetH
        appliedVideoGravity = gravity
        video.layoutParams = if (gravity == Gravity.NO_GRAVITY) {
            FrameLayout.LayoutParams(targetW, targetH)
        } else {
            FrameLayout.LayoutParams(targetW, targetH, gravity)
        }
    }

    fun beginRetirement() {
        if (closing) return
        closing = true
        root.keepScreenOn = false
        videoCallback.close()
        subtitleCallback.close()
    }

    fun retirementStatus(): Int {
        val video = videoCallback.retirementStatus()
        val subtitles = subtitleCallback.retirementStatus()
        return if (video == 2 || subtitles == 2) 2 else if (video == 1 && subtitles == 1) 1 else 0
    }

    fun removeRetired() {
        (root.parent as? ViewGroup)?.removeView(root)
    }

    fun destroyWithActivity() {
        closing = true
        videoCallback.close(abandonReceipt = true)
        subtitleCallback.close(abandonReceipt = true)
        (root.parent as? ViewGroup)?.removeView(root)
    }
}

private class SurfaceCallback(
    private val host: PlayerHost,
    private val handler: Handler,
    private val role: Int,
) : SurfaceHolder.Callback {
    private var holder: SurfaceHolder? = null
    private var bindingId = 0L
    private var retiring = false
    private var closed = false
    private var admissionDeadline = 0L
    private var admissionFailed = false
    private var cleanupDeadline = 0L
    private var cleanupReported = false
    private var admissionError = "Player Surface is unavailable"
    private var desiredFps = 0f
    private val retry = Runnable { admit() }

    fun setDesiredFrameRate(fps: Float) {
        desiredFps = fps
        applySurfaceFrameRate()
    }

    private fun applySurfaceFrameRate() {
        if (role != 1 || desiredFps <= 0f || Build.VERSION.SDK_INT < 30) return
        val surface = holder?.surface?.takeIf { it.isValid } ?: return
        runCatching {
            if (Build.VERSION.SDK_INT >= 31) {
                surface.setFrameRate(desiredFps, Surface.FRAME_RATE_COMPATIBILITY_FIXED_SOURCE, Surface.CHANGE_FRAME_RATE_ALWAYS)
            } else {
                surface.setFrameRate(desiredFps, Surface.FRAME_RATE_COMPATIBILITY_FIXED_SOURCE)
            }
        }
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        if (closed) return
        this.holder = holder
        applySurfaceFrameRate()
        admissionDeadline = 0L
        admissionFailed = false
        admit()
    }
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        if (this.holder !== holder) return
        this.holder = null
        handler.removeCallbacks(retry)
        retire(abandonReceipt = false, forced = true)
    }

    private fun admit() {
        handler.removeCallbacks(retry)
        val source = holder ?: return
        if (closed) return
        if (retiring && retirementStatus() != 1) {
            if (!cleanupReported && SystemClock.uptimeMillis() >= cleanupDeadline) {
                cleanupReported = true
                host.failure("Previous player Surface has not retired")
            }
            // Cleanup does not spend the replacement's admission budget.
            // Retain one observer even after the deadline has been reported.
            handler.postDelayed(retry, if (cleanupReported) 1_000L else 50L)
            return
        }
        if (bindingId != 0L || admissionFailed) return
        if (admissionDeadline == 0L) {
            admissionDeadline = SystemClock.uptimeMillis() + 5_000L
        }
        if (source.surface.isValid) {
            try {
                val id = NativePlayer.registerSurface(source.surface, role)
                if (id > 0) {
                    // Save ownership before querying an error or doing anything
                    // else that can throw. Failed binds still own a receipt.
                    bindingId = id
                    val error = NativePlayer.surfaceRegistrationError(id)
                    if (error == null) return
                    admissionError = error
                } else {
                    admissionError = "Player Surface admission returned no registration"
                }
            } catch (error: Exception) {
                admissionError = error.message ?: error.javaClass.simpleName
            }
        }
        if (bindingId != 0L) {
            admissionFailed = true
            host.failure(admissionError)
            retire(abandonReceipt = false)
            handler.postDelayed(retry, 50L)
        } else if (SystemClock.uptimeMillis() < admissionDeadline) {
            handler.postDelayed(retry, 50L)
        } else {
            admissionFailed = true
            host.failure(admissionError)
        }
    }

    private fun retire(abandonReceipt: Boolean, forced: Boolean = abandonReceipt) {
        if (bindingId == 0L) return
        if (!retiring) {
            cleanupDeadline = SystemClock.uptimeMillis() + 5_000L
            cleanupReported = false
        }
        admissionDeadline = 0L
        retiring = true
        var status = try {
            NativePlayer.retireSurface(bindingId, !abandonReceipt)
        } catch (error: Exception) {
            host.failure("Cannot retire player Surface: ${error.message}")
            2
        }
        // The framework tears the Surface down as soon as surfaceDestroyed returns. A
        // platform decoder still stopping on it then fails, its cleanup can never be
        // proved, and every later Surface is held. The native owner lets go within a few
        // milliseconds, so give it a bounded moment while the Surface still exists.
        if (forced && !abandonReceipt) {
            val until = SystemClock.uptimeMillis() + RELEASE_WAIT_MS
            while (status == 0 && SystemClock.uptimeMillis() < until) {
                Thread.sleep(2)
                status = retirementStatus()
            }
        }
        if (status == 1 || abandonReceipt) {
            bindingId = 0L
            retiring = false
        }
        if (forced && status != 1) {
            Log.w("PearTubePlayer", "Framework removed Surface role $role before native cleanup completed (status=$status)")
        }
    }

    fun retirementStatus(): Int {
        if (bindingId == 0L) return 1
        return try {
            val status = NativePlayer.surfaceRetirementStatus(bindingId)
            if (status == 1) {
                bindingId = 0L
                retiring = false
            }
            status
        } catch (error: Exception) {
            Log.e("PearTubePlayer", "Cannot observe Surface retirement", error)
            2
        }
    }

    fun close(abandonReceipt: Boolean = false) {
        closed = true
        handler.removeCallbacks(retry)
        holder = null
        retire(abandonReceipt)
    }
}
