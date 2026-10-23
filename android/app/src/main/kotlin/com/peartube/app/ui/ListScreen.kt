package com.peartube.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peartube.app.AppModel
import com.peartube.app.Entry
import com.peartube.app.Screen
import com.peartube.app.formatBytes
import com.peartube.app.label

@Composable
fun ListScreen(model: AppModel) {
    val settings by model.settings.collectAsState()
    val status by model.status.collectAsState()
    val entries by model.entries.collectAsState()
    val query by model.query.collectAsState()
    val focus = LocalFocusManager.current

    val peers = status?.let { it.peers + it.lanPeers } ?: 0
    val tracker = status?.tracker ?: settings.tracker
    val short = if (tracker.length >= 8) tracker.take(8) + "…" else tracker
    val facts = "$peers peers · ${formatBytes(status?.blobBytes ?: 0)} · $short"
    // Grouped by title: groups in case-insensitive order, episodes by id.
    val groups = remember(entries, query) { groups(entries, query.lowercase()) }

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("PearTube", fontSize = 24.sp, fontWeight = FontWeight.Bold, color = Ink, modifier = Modifier.weight(1f))
                TextButton(onClick = { model.screen.value = Screen.Settings }) { Text("⚙", fontSize = 22.sp, color = Ink) }
            }
            Text(facts, color = Dim, fontSize = 14.sp)
            status?.lan?.let { Text("LAN $it", color = Dim, fontSize = 14.sp) }
            OutlinedTextField(
                value = query,
                onValueChange = { model.query.value = it },
                placeholder = { Text("Search title or ID…") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    imeAction = ImeAction.Search,
                ),
                keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
                colors = fieldColors(),
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp, end = 12.dp),
            )
        }
        HorizontalDivider(color = Line)
        when {
            groups.isNotEmpty() -> LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                // No item keys: entries arrive in batches while the tracker syncs, and keyed
                // items would scroll to keep the first row seen; by index the list stays put.
                groups.forEach { (title, rows) ->
                    item {
                        Text(title, color = Dim, fontSize = 15.sp, fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(start = 4.dp, top = 16.dp, bottom = 8.dp))
                    }
                    item {
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(CardBg)
                            .border(1.dp, Line, RoundedCornerShape(10.dp))) {
                            rows.forEachIndexed { i, entry ->
                                if (i > 0) HorizontalDivider(color = Line)
                                Row(entry) { model.screen.value = Screen.Play(entry) }
                            }
                        }
                    }
                }
            }
            else -> {
                val message = when {
                    entries.isNotEmpty() -> "No matching entries."
                    status == null -> "Joining the tracker…"
                    else -> "Nothing in this tracker yet. Entries appear as relays announce them."
                }
                Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.TopCenter) {
                    Text(message, color = Dim, fontSize = 15.sp)
                }
            }
        }
    }
}

@Composable
private fun Row(entry: Entry, onClick: () -> Unit) {
    val where = if (entry.local) "on this device" else "from peers"
    Column(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(label(entry.id), color = Ink, fontSize = 17.sp)
        Text("${formatBytes(entry.size)} · $where", color = Dim, fontSize = 14.sp)
    }
}

private fun groups(entries: List<Entry>, q: String): List<Pair<String, List<Entry>>> {
    val rows = entries
        .filter { q.isEmpty() || it.title.lowercase().contains(q) || it.id.lowercase().contains(q) }
        .distinctBy { it.id }
        .sortedWith(compareBy<Entry>({ it.title.lowercase() }, { it.title }, { it.id }))
    val out = mutableListOf<Pair<String, MutableList<Entry>>>()
    for (entry in rows) {
        if (out.lastOrNull()?.first == entry.title) out.last().second += entry
        else out += entry.title to mutableListOf(entry)
    }
    return out
}

@Composable
fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = Ink,
    unfocusedTextColor = Ink,
    focusedContainerColor = CardBg,
    unfocusedContainerColor = CardBg,
    focusedBorderColor = Brand,
    unfocusedBorderColor = Line,
    focusedPlaceholderColor = Dim,
    unfocusedPlaceholderColor = Dim,
    cursorColor = Brand,
)
