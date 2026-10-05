package com.bindercardtracker.binder

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.io.File

/**
 * The Android counterpart of the desktop window: a native WebView pointed at the same C++ backend the desktop
 * app runs (see [NativeBackend]), serving the same frontend over localhost.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val MAX_LOAD_RETRIES = 40 // ~10s at 250ms apart
        private const val RETRY_DELAY_MS = 250L
    }

    private var serverUrl = ""

    private lateinit var webView: WebView
    private lateinit var loadingOverlay: View
    private val mainHandler = Handler(Looper.getMainLooper())
    private var loadAttempts = 0

    private val requestCameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* handled lazily by onPermissionRequest below */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        loadingOverlay = findViewById(R.id.loadingOverlay)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestCameraPermission.launch(Manifest.permission.CAMERA)
        }

        val frontendDir = extractFrontendAssets()
        val port = NativeBackend.start(filesDir.absolutePath, frontendDir.absolutePath, 0)
        if (port <= 0) {
            // Nothing to load; the reason is in logcat (tag "Binder").
            loadingOverlay.visibility = View.GONE
            return
        }
        serverUrl = "http://127.0.0.1:$port/"
        configureWebView()
        loadWhenReady()
    }

    /** Copies assets/frontend/ (bundled by app/build.gradle.kts's
     * copyFrontendAssets task) to a real filesystem path under this app's
     * private storage — Android assets aren't plain files the native
     * code can open, only reachable through AssetManager, so this makes
     * them a normal directory the C++ server can serve. Cheap enough (a
     * few small text files) to redo on every launch rather than caching. */
    private fun extractFrontendAssets(): File {
        val dest = File(filesDir, "frontend")
        copyAssetDir("frontend", dest)
        return dest
    }

    private fun copyAssetDir(assetPath: String, destDir: File) {
        destDir.mkdirs()
        val entries = assets.list(assetPath) ?: return
        if (entries.isEmpty()) {
            // A file, not a directory — list() returns empty for files too.
            return
        }
        for (entry in entries) {
            val childAssetPath = "$assetPath/$entry"
            val childEntries = assets.list(childAssetPath)
            if (childEntries != null && childEntries.isNotEmpty()) {
                copyAssetDir(childAssetPath, File(destDir, entry))
            } else {
                assets.open(childAssetPath).use { input ->
                    File(destDir, entry).outputStream().use { output -> input.copyTo(output) }
                }
            }
        }
    }

    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The scan flow calls getUserMedia() as soon as its modal
            // opens (see js/app.js) — same UX as the desktop build, which
            // doesn't wait for an extra tap either.
            mediaPlaybackRequiresUserGesture = false
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val hasCamera = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) ==
                        PackageManager.PERMISSION_GRANTED
                    val videoResources = request.resources.filter { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE }
                    if (hasCamera && videoResources.isNotEmpty()) {
                        request.grant(videoResources.toTypedArray())
                    } else {
                        request.deny()
                    }
                }
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                loadingOverlay.visibility = View.GONE
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                // The server thread may not be accepting yet — retry instead
                // of showing a dead page. See loadWhenReady().
                if (request.isForMainFrame) {
                    scheduleRetry()
                }
            }
        }
    }

    private fun loadWhenReady() {
        loadAttempts = 0
        webView.loadUrl(serverUrl)
    }

    private fun scheduleRetry() {
        loadAttempts++
        if (loadAttempts >= MAX_LOAD_RETRIES) {
            return // give up silently rather than loop forever; onReceivedError already logged it
        }
        mainHandler.postDelayed({ webView.loadUrl(serverUrl) }, RETRY_DELAY_MS)
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
