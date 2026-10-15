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

sealed interface Screen {
    data object List : Screen
    data object Settings : Screen
    data class Play(val entry: Entry) : Screen
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
    val screen = MutableStateFlow<Screen>(if (settings.value.tracker.isEmpty()) Screen.Settings else Screen.List)

    // The MIDI SoundFont. Imports run here, so leaving Settings does not cancel one.
    val soundFontSelected = MutableStateFlow(SoundFont.file(dataDir).isFile)
    val soundFontBusy = MutableStateFlow(false)
    val soundFontError = MutableStateFlow<String?>(null)

    // Starts run one at a time; a burst of updates costs one refresh.
    private val starts = Channel<Settings>(Channel.UNLIMITED)
    private val refreshes = Channel<Unit>(Channel.CONFLATED)

    init {
        // Main.immediate subscribes before the first start is sent, so no update is missed.
        scope.launch {
            worker.events.collect { event ->
                when (event) {
                    Worker.Event.Update -> refreshes.trySend(Unit)
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
        if (settings.value.tracker.isNotEmpty()) starts.trySend(settings.value)
    }

    /** Saves new settings and joins with them. Throws when they cannot be saved. */
    fun save(next: Settings) {
        next.save(dataDir)
        settings.value = next
        status.value = null
        entries.value = emptyList()
        screen.value = Screen.List
        starts.trySend(next)
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
        if (settings.value.tracker.isEmpty()) return
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
