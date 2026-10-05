package com.bindercardtracker.binder

/**
 * The C++ backend (native/binder_android) — card store, recognition and the HTTP server the WebView talks to.
 */
object NativeBackend {
    init {
        System.loadLibrary("onnxruntime") // packaged from the onnxruntime-android AAR; libbinder_native links against it
        System.loadLibrary("binder_native")
    }

    /**
     * Starts the backend (once; later calls return the port it's already serving on). [filesDir] holds db.json,
     * the logs and the card catalog (under data/); [frontendDir] is the extracted frontend assets. [port] <= 0
     * picks a free one. Returns the port, or -1 if it couldn't start (the reason is in logcat, tag "Binder").
     */
    @JvmStatic
    external fun start(filesDir: String, frontendDir: String, port: Int): Int

    @JvmStatic
    external fun stop()
}
