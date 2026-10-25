package com.peartube.app

import android.app.Application
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import android.util.AtomicFile

sealed interface Screen {
    data object List : Screen
    data object Settings : Screen
    data object Cast : Screen
    data class Play(val entry: Entry, val startPositionMs: Long? = null) : Screen
}

/** The app's state. Lives with the process, so it outlasts the activity. */
class AppModel(private val app: Application) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val dataDir = app.filesDir

    val worker = Worker(app)
    val settings = MutableStateFlow(Settings.load(dataDir))
    val status = MutableStateFlow<Status?>(null)
    val entries = MutableStateFlow<List<Entry>>(emptyList())
    val error = MutableStateFlow<String?>(null)
    val query = MutableStateFlow("")
    val quickAdd = MutableStateFlow("")
    val screen = MutableStateFlow<Screen>(if (!settings.value.hasSources) Screen.Settings else Screen.List)

    val cast = MutableStateFlow(CastStatus())
    val pendingCast = MutableStateFlow<PendingCast?>(null)
    val selectedCastReceiver = MutableStateFlow<CastReceiver?>(null)
    val notice = MutableStateFlow<String?>(null)
    private val historyFile = AtomicFile(File(dataDir, "watch-history.json"))
    val watchHistory = MutableStateFlow(loadWatchHistory())
    private val historyWrites = Channel<Map<String, WatchProgress>>(Channel.CONFLATED)

    private fun loadWatchHistory(): Map<String, WatchProgress> = runCatching {
        val json = JSONObject(historyFile.openRead().bufferedReader().use { it.readText() })
        json.keys().asSequence().associateWith { WatchProgress.from(json.getJSONObject(it)) }
    }.getOrDefault(emptyMap())

    fun recordWatchProgress(entry: Entry, positionMs: Long, durationMs: Long?) {
        if (positionMs <= 0) return
        val progress = WatchProgress(entry.key, entry.id, positionMs, durationMs ?: 0L, System.currentTimeMillis())
        watchHistory.value = watchHistory.value + (entry.key to progress)
        historyWrites.trySend(watchHistory.value)
    }

    fun playEntry(entry: Entry) {
        val receiver = cast.value.session?.receiverId ?: selectedCastReceiver.value?.id
        val start = watchHistory.value[entry.key]?.takeIf { it.partial }?.positionMs ?: 0L
        if (receiver != null) castToReceiver(receiver, entry.key, "auto", start)
        else screen.value = Screen.Play(entry)
    }

    fun openCastSheet() {
        pendingCast.value = null
        screen.value = Screen.Cast
    }

    fun cancelCast() {
        pendingCast.value = null
        screen.value = Screen.List
    }

    fun selectCastReceiver(receiver: CastReceiver) {
        selectedCastReceiver.value = receiver
        val pending = pendingCast.value
        if (pending != null) castToReceiver(receiver.id, pending.entryKey, "auto", pending.startPositionMs)
        else {
            screen.value = Screen.List
            notice.value = "Ready on ${receiver.name}"
            scope.launch {
                runCatching { worker.castAttach(receiver.id) }.onSuccess { st ->
                    if (st.session?.state?.entry != null) cast.value = st
                }
            }
        }
    }

    fun switchCastToPhone() {
        val session = cast.value.session ?: return
        val entry = entries.value.firstOrNull { it.key == session.state.entry?.key } ?: return
        recordWatchProgress(entry, session.state.positionMs, session.state.durationMs)
        selectedCastReceiver.value = null
        stopCasting()
        screen.value = Screen.Play(entry)
    }
    @Volatile var inForeground: Boolean = true
    val soundFontSelected = MutableStateFlow(SoundFont.file(dataDir).isFile)
    val soundFontBusy = MutableStateFlow(false)
    val soundFontError = MutableStateFlow<String?>(null)

    private val starts = Channel<Settings>(Channel.UNLIMITED)
    private val refreshes = Channel<Unit>(Channel.CONFLATED)

    init {
        scope.launch(Dispatchers.IO) {
            for (history in historyWrites) {
                val json = JSONObject()
                history.forEach { (key, progress) -> json.put(key, progress.json()) }
                var stream: java.io.FileOutputStream? = null
                try {
                    stream = historyFile.startWrite()
                    stream.write(json.toString().toByteArray(Charsets.UTF_8))
                    historyFile.finishWrite(stream)
                } catch (_: Exception) {
                    stream?.let(historyFile::failWrite)
                }
            }
        }
        scope.launch {
            worker.events.collect { event ->
                when (event) {
                    Worker.Event.Update -> refreshes.trySend(Unit)
                    is Worker.Event.Sources -> {
                        val synced = event.list.filter { !it.primary && !it.writable }.map { SourceSpec(it.key, it.kind, it.alias) }
                        val next = settings.value.copy(sources = synced)
                        runCatching { next.save(dataDir) }
                        settings.value = next
                    }
                    is Worker.Event.Cast -> {
                        cast.value = event.status
                        if (!inForeground && !shouldKeepWorkerAwake()) worker.suspend()
                    }
                    is Worker.Event.Fatal -> error.value = event.message
                    Worker.Event.Exited -> error.value = "The P2P worker stopped"
                }
            }
        }
        scope.launch {
            for (next in starts) {
                try {
                    worker.start(next)
                    refresh()
                } catch (e: Exception) {
                    error.value = e.message
                }
            }
        }
        scope.launch {
            for (unit in refreshes) refresh()
        }
        if (settings.value.hasSources) starts.trySend(settings.value)
    }

    fun save(next: Settings) {
        next.save(dataDir)
        settings.value = next
        status.value = null
        entries.value = emptyList()
        screen.value = Screen.List
        starts.trySend(next)
    }

    fun shouldKeepWorkerAwake(): Boolean = cast.value.session != null

    fun openUriOrKey(raw: String) {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return
        val isReceiverUri = trimmed.startsWith("peartube://receiver/", ignoreCase = true) ||
            trimmed.startsWith("peartube://cast/", ignoreCase = true)
        if (!settings.value.hasSources && !isReceiverUri) {
            val candidate = if (trimmed.startsWith("peartube:", ignoreCase = true)) trimmed else "peartube://channel/$trimmed"
            runCatching { Settings.parseSourceToken(candidate, "channel") }.onSuccess { spec ->
                val next = settings.value.withSource(spec)
                runCatching { save(next) }.onFailure { error.value = it.message }
                return
            }
        }
        scope.launch {
            try {
                val res = worker.openUri(trimmed)
                res.source?.let { src ->
                    val next = settings.value.withSource(SourceSpec(src.key, src.kind, src.alias))
                    next.save(dataDir)
                    settings.value = next
                    screen.value = Screen.List
                }
                res.entry?.let { entry ->
                    screen.value = Screen.Play(entry)
                }
                if (res.action == "receiver") {
                    cast.value = worker.castStatus()
                    val receiver = res.receiver ?: error("This TV didn't share its identity. Please scan again.")
                    selectCastReceiver(receiver)
                }
                refresh()
            } catch (e: Exception) {
                error.value = e.message
            }
        }
    }

    fun castEntryOrSheet(entry: Entry, startPositionMs: Long = 0L) {
        val activeId = cast.value.session?.receiverId ?: selectedCastReceiver.value?.id
        if (activeId != null) {
            castToReceiver(activeId, entry.key, "auto", startPositionMs)
        } else {
            pendingCast.value = PendingCast(entry.key, entry.title, startPositionMs)
            screen.value = Screen.Cast
        }
    }

    fun refreshCast() {
        scope.launch {
            runCatching { worker.castStatus() }.onSuccess { cast.value = it }.onFailure { error.value = it.message }
        }
    }

    fun pairCastByCode(id: String, code: String) {
        scope.launch {
            val target = cast.value.receivers.firstOrNull { it.id == id }
            runCatching { worker.castPair(JSONObject().put("id", id).put("code", code)) }
                .onSuccess { result ->
                    cast.value = result
                    val receiver = result.receivers.firstOrNull { it.id == id && it.paired }
                        ?: result.receivers.firstOrNull { it.paired && target != null &&
                            ((it.publicKey.isNotEmpty() && it.publicKey == target.publicKey) ||
                                (it.host != null && it.host == target.host && it.port == target.port)) }
                    if (receiver != null) selectCastReceiver(receiver)
                    else error.value = "This TV didn't finish connecting. Please scan its QR code."
                }
                .onFailure { error.value = it.message }
        }
    }

    fun pairCastByUriOrHost(raw: String) {
        val trimmed = raw.trim()
        if (trimmed.startsWith("peartube:", ignoreCase = true)) {
            openUriOrKey(trimmed)
            return
        }
        val uri = Uri.parse(if (trimmed.startsWith("http")) trimmed else "http://$trimmed")
        if (uri.getQueryParameter("uri")?.startsWith("peartube:") == true) {
            openUriOrKey(uri.getQueryParameter("uri")!!)
            return
        }
        val payload = if (':' in trimmed || trimmed.startsWith("http")) {
            JSONObject().put("host", uri.host).put("port", uri.port.takeIf { it > 0 } ?: 8176)
        } else JSONObject().put("publicKey", trimmed)
        scope.launch {
            runCatching { worker.castPair(payload) }
                .onSuccess { result ->
                    cast.value = result
                    val receiver = result.receivers.firstOrNull { it.paired &&
                        (if (payload.has("publicKey")) it.publicKey == trimmed
                        else it.host == uri.host && it.port == payload.optInt("port")) }
                    if (receiver != null) selectCastReceiver(receiver)
                    else error.value = "Couldn't identify that screen. Select it on Wi-Fi or scan its TV QR code."
                }
                .onFailure { error.value = it.message }
        }
    }

    fun removeCastReceiver(id: String) {
        scope.launch {
            runCatching { worker.castRemove(id) }.onSuccess { cast.value = it }
        }
    }

    fun castToReceiver(receiverId: String, key: String, preferMode: String = "auto", startPositionMs: Long = 0L) {
        scope.launch {
            try {
                cast.value = worker.castPlay(receiverId, key, preferMode, startPositionMs)
                pendingCast.value = null
                screen.value = Screen.List
            } catch (e: Exception) {
                error.value = e.message
            }
        }
    }

    fun sendCastControl(params: JSONObject) {
        scope.launch {
            runCatching { worker.castControl(params) }.onSuccess { cast.value = it }.onFailure { error.value = it.message }
        }
    }

    fun stopCasting() {
        selectedCastReceiver.value = null
        scope.launch {
            runCatching { worker.castStop(true) }.onSuccess {
                cast.value = it
                if (!inForeground && !shouldKeepWorkerAwake()) worker.suspend()
            }
        }
    }

    fun detachCasting() {
        selectedCastReceiver.value = null
        scope.launch {
            runCatching { worker.castStop(false) }.onSuccess {
                cast.value = it
                if (!inForeground && !shouldKeepWorkerAwake()) worker.suspend()
            }
        }
    }


    fun subscribeDiscovered(disc: DiscoveredSource) {
        openUriOrKey("peartube://${disc.kind}/${disc.key}?name=${disc.title}")
    }
    fun clearCache(key: String? = null) {
        scope.launch {
            try {
                notice.value = "Clearing cache & compacting storage…"
                val (cleared, reclaimed) = worker.clearCache(key)
                refresh()
                fun fmt(b: Long): String {
                    val mb = b / (1024.0 * 1024.0)
                    return when {
                        b >= 1024L * 1024L * 1024L -> String.format(java.util.Locale.US, "%.2f GB", mb / 1024.0)
                        b >= 1024L * 1024L -> String.format(java.util.Locale.US, "%.1f MB", mb)
                        else -> "${maxOf(1L, b / 1024L)} KB"
                    }
                }
                notice.value = when {
                    reclaimed > 0L -> "Freed ${fmt(reclaimed)} on device"
                    cleared > 0L -> "Cleared ${fmt(cleared)} from cache"
                    else -> "Storage cache compacted"
                }
            } catch (e: Exception) {
                error.value = e.message
            }
        }
    }
    fun importSoundFont(uri: Uri) = soundFontJob { SoundFont.import(app.contentResolver, uri, dataDir) }

    fun clearSoundFont() = soundFontJob { SoundFont.clear(dataDir) }

    private fun soundFontJob(work: () -> Unit) {
        soundFontBusy.value = true
        soundFontError.value = null
        scope.launch {
            try {
                withContext(Dispatchers.IO) { work() }
            } catch (e: Exception) {
                soundFontError.value = e.message
            }
            soundFontSelected.value = SoundFont.file(dataDir).isFile
            soundFontBusy.value = false
        }
    }

    private suspend fun refresh() {
        if (!settings.value.hasSources) return
        try {
            coroutineScope {
                val st = async { worker.status() }
                val en = async { worker.search() }
                status.value = st.await()
                entries.value = en.await()
            }
        } catch (e: Exception) {
            error.value = e.message
        }
    }
}
