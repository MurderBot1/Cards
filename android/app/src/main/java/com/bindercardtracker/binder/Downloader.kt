package com.bindercardtracker.binder

import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * HTTP downloads for the C++ backend (native/binder_android/src/jni_bridge.cpp), which has no libcurl on Android:
 * it calls [download] from its background thread to fetch the card catalog on first launch.
 */
object Downloader {
    private const val BUFFER_BYTES = 256 * 1024

    /**
     * GETs [url] (following redirects; GitHub release assets redirect to a CDN) into [dest], which is created or
     * truncated. Returns the HTTP status; on a non-2xx status nothing is left at [dest]. [timeoutSeconds] bounds
     * connecting and a stalled read, not the whole transfer. Throws on a connection failure (the C++ side turns
     * that into its own error).
     */
    @JvmStatic
    fun download(url: String, dest: String, timeoutSeconds: Int): Int {
        val file = File(dest)
        file.parentFile?.mkdirs()
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = timeoutSeconds * 1000
            conn.readTimeout = timeoutSeconds * 1000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", "BinderCardTracker/1.0 (personal card-collection app)")
            val status = conn.responseCode
            if (status !in 200..299) {
                file.delete()
                return status
            }
            conn.inputStream.use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(BUFFER_BYTES)
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        output.write(buffer, 0, n)
                    }
                }
            }
            return status
        } catch (e: Exception) {
            file.delete()
            throw e
        } finally {
            conn.disconnect()
        }
    }
}
