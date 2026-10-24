package com.peartube.app

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import org.json.JSONArray
import org.json.JSONObject
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

class WorkerException(message: String) : Exception(message)

/**
 * The P2P worker: a Bare worklet running worklet/worker.js, the relay's own core. We talk
 * to it in newline-delimited JSON over bare-kit's IPC; worker.js documents the messages.
 * Every bare-kit call runs on one thread, whose looper also delivers IPC readiness.
 */
class Worker(context: Context) {
    sealed interface Event {
        /** The tracker, the peer set or LAN discovery changed. */
        data object Update : Event

        /** The worker hit an uncaught error. */
        data class Fatal(val message: String) : Event

        /** The worklet closed its IPC; no more replies will come. */
        data object Exited : Event
    }

    private val handler = Handler(HandlerThread("peartube-worklet").apply { start() }.looper)
    private val storeDir = context.noBackupFilesDir
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<Any?>>()
    private val nextId = AtomicLong(1)
    private val _events = MutableSharedFlow<Event>(extraBufferCapacity = 64)
    val events: SharedFlow<Event> = _events

    // Worklet thread only.
    private var worklet: Worklet? = null
    private var ipc: IPC? = null
    private val outgoing = ArrayDeque<ByteBuffer>()
    private val incoming = ByteArrayOutputStream()
    private var failure: String? = null

    init {
        handler.post {
            try {
                // Where bare-kit unpacks assets: the files dir, as in the Dioxus app.
                val assets = File(context.filesDir, "bare-assets").apply { mkdirs() }
                val bundle = context.assets.open("worker.bundle").use { it.readBytes() }
                val source = ByteBuffer.allocateDirect(bundle.size)
                source.put(bundle)
                source.flip()
                val worklet = Worklet(Worklet.Options().assets(assets.path))
                worklet.start("/worker.bundle", source, null)
                val ipc = IPC(worklet)
                this.worklet = worklet
                this.ipc = ipc
                ipc.readable { read(ipc) }
            } catch (e: Throwable) {
                fail("The P2P worker did not start: ${e.message ?: e}")
            }
        }
    }

    suspend fun start(settings: Settings): Status {
        val params = JSONObject()
            .put("storage", File(storeDir, "trackers/${settings.tracker}").path)
            .put("tracker", settings.tracker)
            .put("relayThrough", if (settings.relayThrough.isEmpty()) JSONObject.NULL else JSONArray(settings.relayThrough))
            .put("bootstrap", if (settings.bootstrap.isEmpty()) JSONObject.NULL else JSONArray(settings.bootstrap))
            .put("lan", settings.lanDiscovery)
            .put("privateRouting", settings.privateRouting)
        return Status.from(call("start", params) as JSONObject)
    }

    suspend fun status(): Status = Status.from(call("status") as JSONObject)

    /** Every entry in the tracker. */
    suspend fun search(): List<Entry> {
        val list = call("search", JSONObject().put("id", JSONObject.NULL)) as JSONArray
        return List(list.length()) { Entry.from(list.getJSONObject(it)) }
    }

    suspend fun clearCache(key: String? = null) {
        call("clearCache", JSONObject().put("key", key ?: JSONObject.NULL))
    }

    /** Stops the worklet's I/O while the app is in the background. */
    fun suspend() = handler.post { worklet?.suspend() }

    fun resume() = handler.post { worklet?.resume() }

    private suspend fun call(method: String, params: JSONObject = JSONObject()): Any? {
        val id = nextId.getAndIncrement()
        val reply = CompletableDeferred<Any?>()
        val line = JSONObject().put("id", id).put("method", method).put("params", params).toString() + "\n"
        // On the worklet thread, where fail() runs: a failure can't land between the check and
        // the registration and leave the reply unanswered.
        handler.post {
            val failed = failure
            if (failed != null) {
                reply.completeExceptionally(WorkerException(failed))
            } else {
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

    // IPC.write takes a buffer from its start to its limit, so a partial write leaves a slice.
    private fun flush() {
        val ipc = ipc ?: return
        while (outgoing.isNotEmpty()) {
            val buffer = outgoing.first()
            val written = ipc.write(buffer)
            if (written < buffer.limit()) {
                buffer.position(written)
                outgoing[0] = buffer.slice()
                ipc.writable { flush() }
                return
            }
            outgoing.removeFirst()
        }
        ipc.writable(null)
    }

    private fun read(ipc: IPC) {
        while (true) {
            val data = ipc.read() ?: return
            if (data.limit() == 0) {
                ipc.readable(null)
                fail("The P2P worker stopped")
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
        val msg = try {
            JSONObject(line)
        } catch (e: Exception) {
            _events.tryEmit(Event.Fatal("Malformed message from the P2P worker: ${e.message}"))
            return
        }
        if (msg.has("id")) {
            val reply = pending.remove(msg.getLong("id")) ?: return
            if (msg.has("error")) reply.completeExceptionally(WorkerException(msg.optString("error")))
            else reply.complete(msg.opt("result"))
            return
        }
        when (msg.optString("event")) {
            "update" -> _events.tryEmit(Event.Update)
            "fatal" -> _events.tryEmit(Event.Fatal(msg.optString("error")))
        }
    }

    private fun fail(message: String) {
        if (failure != null) return
        failure = message
        pending.values.forEach { it.completeExceptionally(WorkerException(message)) }
        pending.clear()
        _events.tryEmit(Event.Exited)
    }
}
