package com.peartube.app

import android.content.ContentResolver
import android.net.Uri
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * A user-selected MIDI bank, private to this device and never in the Corestore. The player
 * reads files/soundfont.sf2, the same file the Dioxus app used. An import must not replace
 * the selected bank on a read error, oversized input, an invalid RIFF/SF2 header or
 * truncated data; the stream's own length is not trusted.
 */
object SoundFont {
    const val MAX_BYTES = 256L * 1024 * 1024

    fun file(dir: File) = File(dir, "soundfont.sf2")

    fun clear(dir: File) {
        val bank = file(dir)
        if (bank.exists() && !bank.delete()) throw IOException("Cannot remove the SoundFont")
    }

    /** Copies the chosen document (at most [MAX_BYTES]) and keeps it if it is a complete SF2. */
    fun import(resolver: ContentResolver, uri: Uri, dir: File) {
        dir.mkdirs()
        val temporary = File(dir, ".soundfont-import.tmp")
        try {
            val input = resolver.openInputStream(uri) ?: throw IOException("The document provider could not open the selection")
            input.use { source ->
                temporary.outputStream().use { out ->
                    val buffer = ByteArray(64 * 1024)
                    var copied = 0L
                    while (true) {
                        val n = source.read(buffer)
                        if (n < 0) break
                        copied += n
                        if (copied > MAX_BYTES) throw IOException("SoundFont exceeds the import size limit")
                        out.write(buffer, 0, n)
                    }
                }
            }
            RandomAccessFile(temporary, "r").use { file ->
                val header = ByteArray(12)
                if (file.length() < 12) throw IOException("Select a complete SoundFont 2 (.sf2) file")
                file.readFully(header)
                val length = (header[4].toLong() and 0xff) or ((header[5].toLong() and 0xff) shl 8) or
                    ((header[6].toLong() and 0xff) shl 16) or ((header[7].toLong() and 0xff) shl 24)
                val riff = String(header, 0, 4, Charsets.US_ASCII) == "RIFF"
                val sfbk = String(header, 8, 4, Charsets.US_ASCII) == "sfbk"
                if (!riff || !sfbk || file.length() != length + 8) throw IOException("Select a complete SoundFont 2 (.sf2) file")
            }
            if (!temporary.renameTo(file(dir))) throw IOException("Cannot keep the SoundFont")
        } finally {
            temporary.delete()
        }
    }
}
