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
import com.chaquo.python.Python
import java.io.File

/**
 * Android's replacement for pywebview: a native WebView pointed at the
 * same Flask backend the desktop build runs (see
 * android/app/src/main/python/android_main.py), instead of a
 * desktop-only window shell that has no Android build.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val PORT = 5000
        private const val SERVER_URL = "http://127.0.0.1:$PORT/"
        private const val MAX_LOAD_RETRIES = 40 // ~10s at 250ms apart — generous for a cold ONNX Runtime warm_up()
        private const val RETRY_DELAY_MS = 250L
    }

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
        startBackend(frontendDir)
        configureWebView()
        loadWhenReady()
    }

    /** Copies assets/frontend/ (bundled by app/build.gradle.kts's
     * copyFrontendAssets task) to a real filesystem path under this app's
     * private storage — Android assets aren't directly openable by
     * Python's `open()`/Flask's send_from_directory, only via
     * AssetManager, so this makes them a normal directory paths.py and
     * Flask can just read like any other. Cheap enough (a few small
     * text files) to redo on every launch rather than caching. */
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

    private fun startBackend(frontendDir: File) {
        val py = Python.getInstance()
        py.getModule("android_main").callAttr("start", filesDir.absolutePath, frontendDir.absolutePath, PORT)
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
                // Flask is still coming up on android_main.py's background
                // thread — retry instead of showing a dead page. See
                // loadWhenReady().
                if (request.isForMainFrame) {
                    scheduleRetry()
                }
            }
        }
    }

    private fun loadWhenReady() {
        loadAttempts = 0
        webView.loadUrl(SERVER_URL)
    }

    private fun scheduleRetry() {
        loadAttempts++
        if (loadAttempts >= MAX_LOAD_RETRIES) {
            return // give up silently rather than loop forever; onReceivedError already logged it
        }
        mainHandler.postDelayed({ webView.loadUrl(SERVER_URL) }, RETRY_DELAY_MS)
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
