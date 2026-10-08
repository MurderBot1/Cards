package com.bindercardtracker.binder

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * In-app updates on Android (the page's js/updates.js talks to this through the `BinderAndroid` bridge, the same
 * shape the desktop backend's /api/update/* routes have): downloads the release's APK into the app's cache, checks it
 * against the SHA-256 GitHub publishes for it, then opens the system installer on it. Android always asks the user to
 * confirm an install, and it only replaces this app if the APK is signed with the same key (see BUILDING.md).
 */
class ApkUpdater(private val context: Context) {

    companion object {
        private val URL_PATTERN =
            Regex("^https://github\\.com/MurderBot1/Cards/releases/download/v\\d+\\.\\d+\\.\\d+/Binder-android-debug\\.apk$")
        private val SHA_PATTERN = Regex("^[0-9a-fA-F]{64}$")
        private const val BUFFER_BYTES = 256 * 1024
    }

    @Volatile private var state = "idle" // idle | downloading | ready | error
    @Volatile private var bytes = 0L
    @Volatile private var total = 0L
    @Volatile private var error = ""
    @Volatile private var version = ""
    private var apk: File? = null

    private fun reply(ok: Boolean, message: String = ""): String =
        JSONObject().put("ok", ok).apply { if (message.isNotEmpty()) put("error", message) }.toString()

    @Synchronized
    fun start(url: String, sha256: String): String {
        if (!URL_PATTERN.matches(url)) return reply(false, "that isn't this project's APK")
        if (!SHA_PATTERN.matches(sha256)) return reply(false, "the release doesn't publish a checksum for it")
        if (state == "downloading") return reply(false, "an update is already downloading")
        val dir = File(context.cacheDir, "updates")
        dir.deleteRecursively()
        dir.mkdirs()
        val target = File(dir, "Binder.apk")
        val part = File(dir, "Binder.apk.part")
        apk = null
        state = "downloading"
        bytes = 0
        total = 0
        error = ""
        version = url.substringAfter("/download/").substringBefore('/')
        val expected = sha256.lowercase()
        Thread {
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                try {
                    conn.connectTimeout = 60_000
                    conn.readTimeout = 60_000
                    conn.instanceFollowRedirects = true
                    conn.setRequestProperty("User-Agent", "BinderCardTracker/1.0 (personal card-collection app)")
                    val code = conn.responseCode
                    if (code !in 200..299) throw IllegalStateException("HTTP $code")
                    total = conn.contentLengthLong.coerceAtLeast(0)
                    val digest = MessageDigest.getInstance("SHA-256")
                    conn.inputStream.use { input ->
                        part.outputStream().use { output ->
                            val buffer = ByteArray(BUFFER_BYTES)
                            while (true) {
                                val n = input.read(buffer)
                                if (n < 0) break
                                output.write(buffer, 0, n)
                                digest.update(buffer, 0, n)
                                bytes += n
                            }
                        }
                    }
                    val actual = digest.digest().joinToString("") { "%02x".format(it) }
                    if (actual != expected) throw IllegalStateException("the download didn't match its checksum, so it wasn't installed")
                    if (!part.renameTo(target)) throw IllegalStateException("couldn't save the download")
                } finally {
                    conn.disconnect()
                }
                apk = target
                total = bytes
                state = "ready"
            } catch (e: Exception) {
                part.delete()
                error = if (e is IllegalStateException) e.message ?: "the download failed" else "the download failed (${e.message})"
                state = "error"
            }
        }.start()
        return reply(true)
    }

    fun status(): String =
        JSONObject().put("ok", true).put("state", state).put("bytes", bytes).put("total", total)
            .put("error", error).put("version", version).toString()

    /** Opens the installer on the downloaded APK, first sending the user to the "install unknown apps" switch for this
     * app if it hasn't been allowed. */
    @Synchronized
    fun install(): String {
        val file = apk
        if (state != "ready" || file == null || !file.exists()) return reply(false, "there's no downloaded update to install")
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
                context.startActivity(
                    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                return reply(false, "Allow Binder to install apps, then tap Install again")
            }
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
            context.startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            reply(true)
        } catch (e: Exception) {
            reply(false, "couldn't open the installer (${e.message})")
        }
    }
}
