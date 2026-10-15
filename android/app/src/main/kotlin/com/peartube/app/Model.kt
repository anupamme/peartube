package com.peartube.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.Locale

/**
 * What the app joins: a tracker, optional blind relays, an optional DHT bootstrap for a
 * private network, and whether to look for relays on the local network. Kept in
 * settings.json in the files dir: the same file and fields the Dioxus app used, so an
 * update in place keeps them.
 */
data class Settings(
    val tracker: String = "",
    val relayThrough: List<String> = emptyList(),
    val bootstrap: List<String> = emptyList(),
    val lanDiscovery: Boolean = false,
) {
    fun save(dir: File) {
        dir.mkdirs()
        val json = JSONObject()
            .put("tracker", tracker)
            .put("relayThrough", JSONArray(relayThrough))
            .put("bootstrap", JSONArray(bootstrap))
            .put("lanDiscovery", lanDiscovery)
        val tmp = File(dir, "settings.json.tmp")
        tmp.writeText(json.toString(2))
        if (!tmp.renameTo(File(dir, "settings.json"))) throw IOException("Cannot save settings.json")
    }

    companion object {
        fun load(dir: File): Settings = try {
            val json = JSONObject(File(dir, "settings.json").readText())
            Settings(
                tracker = json.optString("tracker"),
                relayThrough = json.optJSONArray("relayThrough").strings(),
                bootstrap = json.optJSONArray("bootstrap").strings(),
                lanDiscovery = json.optBoolean("lanDiscovery"),
            )
        } catch (_: Exception) {
            Settings()
        }

        /** Settings from the form's fields. Lists split on commas or whitespace. */
        fun parse(tracker: String, relayThrough: String, bootstrap: String, lan: Boolean): Settings {
            val key = tracker.trim().lowercase()
            require(isKey(key)) { "The tracker key is 64 hex characters." }
            val relays = split(relayThrough).map { it.lowercase() }
            relays.firstOrNull { !isKey(it) }?.let { throw IllegalArgumentException("Relay key $it is not 64 hex characters.") }
            val nodes = split(bootstrap)
            nodes.firstOrNull { !isHostPort(it) }?.let { throw IllegalArgumentException("Bootstrap node $it is not host:port.") }
            return Settings(key, relays, nodes, lan)
        }

        private fun split(list: String) = list.split(',', ' ', '\t', '\n', '\r').filter { it.isNotEmpty() }

        private fun isKey(key: String) = key.length == 64 && key.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }

        private fun isHostPort(node: String): Boolean {
            val i = node.lastIndexOf(':')
            val port = node.substring(i + 1).toIntOrNull()
            return i > 0 && port != null && port in 1..65535
        }
    }
}

/** The worker's status: the core's own plus `lan`, what LAN discovery is doing (null while off). */
data class Status(
    val tracker: String,
    val writer: String,
    val blobs: String,
    val blobBytes: Long,
    val peers: Long,
    val lanPeers: Long,
    val lan: String?,
) {
    companion object {
        fun from(json: JSONObject) = Status(
            tracker = json.getString("tracker"),
            writer = json.optString("writer"),
            blobs = json.optString("blobs"),
            blobBytes = json.optLong("blobBytes"),
            peers = json.optLong("peers"),
            lanPeers = json.optLong("lanPeers"),
            lan = json.optString("lan").takeUnless { json.isNull("lan") || it.isEmpty() },
        )
    }
}

/** One tracker entry, the same shape as the relay's /v1/search results. */
data class Entry(
    val key: String,
    val id: String,
    val title: String,
    val size: Long,
    val sha256: String,
    val local: Boolean,
    val streamUrl: String,
) {
    companion object {
        fun from(json: JSONObject) = Entry(
            key = json.getString("key"),
            id = json.getString("id"),
            title = json.getString("title"),
            size = json.optLong("size"),
            sha256 = json.optString("sha256"),
            local = json.optBoolean("local"),
            streamUrl = json.getString("streamUrl"),
        )
    }
}

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else List(length()) { getString(it) }

fun formatBytes(bytes: Long): String {
    val kb = 1024.0
    val mb = kb * 1024
    val gb = mb * 1024
    return when {
        bytes >= gb -> "%.1f GB".format(Locale.ROOT, bytes / gb)
        bytes >= mb -> "%.1f MB".format(Locale.ROOT, bytes / mb)
        bytes >= kb -> "%.1f KB".format(Locale.ROOT, bytes / kb)
        else -> "$bytes B"
    }
}

/** "S01E02" for an episode id (`tt…:s01e02`), else "Movie". */
fun label(id: String): String {
    val s = id.substringAfterLast(':', "")
    val episode = (s.length == 6 || s.length == 7) &&
        s[0].lowercaseChar() == 's' && s[1].isDigit() && s[2].isDigit() &&
        s[3].lowercaseChar() == 'e' && s[4].isDigit() && s[5].isDigit() &&
        (s.length == 6 || s[6].isDigit())
    return if (episode) s.uppercase() else "Movie"
}
