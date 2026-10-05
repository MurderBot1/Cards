# libbinder_native.so — the backend (store, recognition, HTTP server, routes) for the Android app. The Kotlin
# side loads it, starts it with the app's private directories, and points a WebView at the port it returns.
# Everything is linked in statically except ONNX Runtime, which Gradle packages into the APK.
add_library(binder_native SHARED src/jni_bridge.cpp)
target_link_libraries(binder_native PRIVATE binder_app cardpaths log)
