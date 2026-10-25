package com.peartube.receiver

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.HandlerThread
import android.os.PowerManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

data class TvReceiverInfo(
    val deviceId: String = "",
    val name: String = "PearTube TV",
    val publicKey: String = "",
    val port: Int = 0,
    val pairCode: String = "",
    val pairingUri: String = "",
    val listenUrl: String = "",
    val mode: String? = null,
    val p2pPeers: Long = 0L,
) {
    companion object {
        fun from(json: JSONObject): TvReceiverInfo {
            val st = json.optJSONObject("state")
            return TvReceiverInfo(
                deviceId = json.optString("deviceId"),
                name = json.optString("name", "PearTube TV"),
                publicKey = json.optString("publicKey"),
                port = json.optInt("port"),
                pairCode = json.optString("pairCode"),
                pairingUri = json.optString("pairingUri"),
                listenUrl = json.optString("listenUrl"),
                mode = st?.optString("mode")?.takeUnless { st.isNull("mode") || it.isEmpty() },
                p2pPeers = st?.optLong("p2pPeers") ?: 0L,
            )
        }
    }
}

data class TvCommand(
    val seq: Long = 0L,
    val action: String,
    val title: String = "PearTube Cast",
    val mode: String? = null,
    val streamUrl: String? = null,
    val httpStreamUrl: String? = null,
    val startPositionMs: Long = 0L,
    val positionMs: Long? = null,
    val deltaMs: Long? = null,
    val stream: Int? = null,
) {
    companion object {
        fun from(json: JSONObject): TvCommand {
            val entry = json.optJSONObject("entry")
            return TvCommand(
                seq = json.optLong("seq"),
                action = json.optString("action"),
                title = entry?.optString("title")?.takeIf { it.isNotBlank() } ?: "PearTube Cast",
                mode = json.optString("mode").takeUnless { json.isNull("mode") || it.isEmpty() },
                streamUrl = json.optString("streamUrl").takeUnless { json.isNull("streamUrl") || it.isEmpty() },
                httpStreamUrl = json.optString("httpStreamUrl").takeUnless { json.isNull("httpStreamUrl") || it.isEmpty() },
                startPositionMs = json.optLong("startPositionMs"),
                positionMs = if (json.isNull("positionMs")) null else json.optLong("positionMs"),
                deltaMs = if (json.isNull("deltaMs")) null else json.optLong("deltaMs"),
                stream = if (json.isNull("stream")) null else json.optInt("stream"),
            )
        }
    }
}

class ReceiverWorker(private val appContext: Context) {
    private val handler = Handler(HandlerThread("peartube-tv-worklet").apply { start() }.looper)
    private val castDir = File(appContext.noBackupFilesDir, "cast").path
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<Any?>>()
    private val nextId = AtomicLong(1)

    val info = MutableStateFlow<TvReceiverInfo?>(null)
    val error = MutableStateFlow<String?>(null)
    private val _commands = MutableSharedFlow<TvCommand>(replay = 1, extraBufferCapacity = 32)
    val commands: SharedFlow<TvCommand> = _commands

    @Volatile var isStreaming: Boolean = false
    @Volatile var activityResumed: Boolean = false
    @Volatile var lastHandledSeq: Long = 0L
    private val startLock = Mutex()
    private var worklet: Worklet? = null
    private var ipc: IPC? = null
    private val outgoing = ArrayDeque<ByteBuffer>()
    private val incoming = ByteArrayOutputStream()
    private var failure: String? = null

    init {
        handler.post {
            try {
                val assets = File(appContext.filesDir, "bare-assets").apply { mkdirs() }
                val bundle = appContext.assets.open("worker.bundle").use { it.readBytes() }
                val source = ByteBuffer.allocateDirect(bundle.size)
                source.put(bundle)
                source.flip()
                val w = Worklet(Worklet.Options().assets(assets.path))
                w.start("/worker.bundle", source, null)
                val pipe = IPC(w)
                worklet = w
                ipc = pipe
                pipe.readable { read(pipe) }
            } catch (e: Throwable) {
                fail("Receiver engine failed to start: ${e.message ?: e}")
            }
        }
    }

    suspend fun ensureStarted(name: String, openAuth: Boolean = true): TvReceiverInfo = startLock.withLock {
        info.value?.let { return@withLock it }
        val params = JSONObject()
            .put("storage", castDir)
            .put("name", name)
            .put("openAuth", openAuth)
        val res = TvReceiverInfo.from(call("receiverStart", params) as JSONObject)
        info.value = res
        res
    }

    suspend fun reportState(state: JSONObject) {
        call("receiverReportState", JSONObject().put("storage", castDir).put("state", state))
    }

    private suspend fun call(method: String, params: JSONObject = JSONObject()): Any? {
        val id = nextId.getAndIncrement()
        val reply = CompletableDeferred<Any?>()
        val line = JSONObject().put("id", id).put("method", method).put("params", params).toString() + "\n"
        handler.post {
            val failed = failure
            if (failed != null) reply.completeExceptionally(IllegalStateException(failed))
            else {
                pending[id] = reply
                send(line.toByteArray())
            }
        }
        try {
            return reply.await()
        } finally {
            pending.remove(id)
        }
    }

    private fun send(bytes: ByteArray) {
        if (failure != null) return
        val buffer = ByteBuffer.allocateDirect(bytes.size)
        buffer.put(bytes)
        buffer.flip()
        outgoing.addLast(buffer)
        if (outgoing.size == 1) flush()
    }

    private fun flush() {
        val pipe = ipc ?: return
        while (outgoing.isNotEmpty()) {
            val buffer = outgoing.first()
            val written = pipe.write(buffer)
            if (written < buffer.limit()) {
                buffer.position(written)
                outgoing[0] = buffer.slice()
                pipe.writable { flush() }
                return
            }
            outgoing.removeFirst()
        }
        pipe.writable(null)
    }

    private fun read(pipe: IPC) {
        while (true) {
            val data = pipe.read() ?: return
            if (data.limit() == 0) {
                pipe.readable(null)
                fail("Receiver engine stopped")
                return
            }
            val bytes = ByteArray(data.remaining())
            data.get(bytes)
            var start = 0
            for (i in bytes.indices) {
                if (bytes[i] == '\n'.code.toByte()) {
                    incoming.write(bytes, start, i - start)
                    dispatch(incoming.toString(Charsets.UTF_8.name()))
                    incoming.reset()
                    start = i + 1
                }
            }
            incoming.write(bytes, start, bytes.size - start)
        }
    }

    private fun dispatch(line: String) {
        val msg = runCatching { JSONObject(line) }.getOrNull() ?: return
        if (msg.has("id")) {
            val reply = pending.remove(msg.getLong("id")) ?: return
            if (msg.has("error")) reply.completeExceptionally(IllegalStateException(msg.optString("error")))
            else reply.complete(msg.opt("result"))
            return
        }
        when (msg.optString("event")) {
            "cast" -> {
                msg.optJSONObject("cast")?.optJSONObject("receiverMode")?.let {
                    info.value = TvReceiverInfo.from(it)
                }
            }
            "receiverCommand" -> {
                msg.optJSONObject("command")?.let { raw ->
                    val cmd = TvCommand.from(raw)
                    if (cmd.action == "load" && !activityResumed) {
                        runCatching {
                            @Suppress("DEPRECATION")
                            appContext.getSystemService(PowerManager::class.java)
                                .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "peartube:cast-wake")
                                .acquire(3000L)
                            appContext.startActivity(
                                Intent(appContext, ReceiverActivity::class.java)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                            )
                        }
                    }
                    _commands.tryEmit(cmd)
                }
            }
            "fatal" -> error.value = msg.optString("error")
        }
    }

    private fun fail(message: String) {
        if (failure != null) return
        failure = message
        error.value = message
        pending.values.forEach { it.completeExceptionally(IllegalStateException(message)) }
        pending.clear()
    }
}
