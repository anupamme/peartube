package com.peartube.app.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.Screen
import com.peartube.app.Settings

@Composable
fun SettingsScreen(model: AppModel) {
    val settings by model.settings.collectAsState()
    var tracker by rememberSaveable { mutableStateOf(settings.tracker) }
    var relays by rememberSaveable { mutableStateOf(settings.relayThrough.joinToString(", ")) }
    var bootstrap by rememberSaveable { mutableStateOf(settings.bootstrap.joinToString(", ")) }
    var lan by rememberSaveable { mutableStateOf(settings.lanDiscovery) }
    var privateRouting by rememberSaveable { mutableStateOf(settings.privateRouting) }
    var problem by remember { mutableStateOf<String?>(null) }
    val bankSelected by model.soundFontSelected.collectAsState()
    val bankBusy by model.soundFontBusy.collectAsState()
    val bankError by model.soundFontError.collectAsState()
    // Providers often label SF2 as application/octet-stream, so any type; the import checks the file.
    val pickBank = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(model::importSoundFont)
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Settings", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Ink, modifier = Modifier.weight(1f))
            if (settings.tracker.isNotEmpty()) {
                TextButton(onClick = { model.screen.value = Screen.List }) { Text("Cancel", color = Ink) }
            }
        }
        HorizontalDivider(color = Line)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            problem?.let { Text(it, color = Danger) }
            Field("Tracker key", "64 hex characters, from a relay's /v1/status") {
                KeyField(tracker, singleLine = true) { tracker = it }
            }
            Field("Blind relays", "Optional relay keys, for networks where peers cannot connect directly") {
                KeyField(relays, singleLine = false) { relays = it }
            }
            Field("DHT bootstrap", "Optional host:port list for a private DHT. Empty uses the public DHT.") {
                KeyField(bootstrap, singleLine = false) { bootstrap = it }
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(
                    Modifier.fillMaxWidth().toggleable(value = lan, role = Role.Switch, onValueChange = { lan = it }),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Find relays on this network", color = Ink, fontSize = 16.sp, modifier = Modifier.weight(1f))
                    Switch(checked = lan, onCheckedChange = null, colors = SwitchDefaults.colors(checkedTrackColor = Brand))
                }
                Hint("Over mDNS, on this device's Wi-Fi or Ethernet, for relays that run with PEARTUBE_LAN_HOST. Turn it on where peers on one network cannot reach each other through the internet.")
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(
                    Modifier.fillMaxWidth().toggleable(value = privateRouting, role = Role.Switch, onValueChange = { privateRouting = it }),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Private DHT routing", color = Ink, fontSize = 16.sp, modifier = Modifier.weight(1f))
                    Switch(checked = privateRouting, onCheckedChange = null, colors = SwitchDefaults.colors(checkedTrackColor = Brand))
                }
                Hint("Route peer connections over 4-hop encrypted relay circuits. Every peer you connect to must also run with private routing.")
            }
            Field("MIDI SoundFont", "Choose your own SoundFont 2 (.sf2), up to 256 MiB. No bank is bundled. Changes are saved immediately, only on this device.") {
                bankError?.let { Text(it, color = Danger) }
                Hint(if (bankSelected) "A SoundFont is selected." else "No SoundFont selected. MIDI needs one to play.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(enabled = !bankBusy, onClick = { pickBank.launch(arrayOf("*/*")) }) {
                        Text(if (bankBusy) "Importing…" else "Choose .sf2 file", color = Ink)
                    }
                    if (bankSelected) {
                        OutlinedButton(enabled = !bankBusy, onClick = model::clearSoundFont) { Text("Remove SoundFont", color = Ink) }
                    }
                }
            }
            Button(
                onClick = {
                    problem = try {
                        model.save(Settings.parse(tracker, relays, bootstrap, lan, privateRouting))
                        null
                    } catch (e: Exception) {
                        e.message
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = Brand),
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Save") }
            Spacer(Modifier.padding(8.dp))
        }
    }
}

@Composable
private fun Field(label: String, hint: String, input: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        Hint(hint)
        input()
    }
}

@Composable
private fun Hint(text: String) = Text(text, color = Dim, fontSize = 13.sp)

@Composable
private fun KeyField(value: String, singleLine: Boolean, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 3,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
        colors = fieldColors(),
        modifier = Modifier.fillMaxWidth(),
    )
}
