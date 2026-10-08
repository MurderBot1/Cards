plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The backend (store, card recognition, HTTP server) is C++ — native/ — built by CMake through the NDK into
// libbinder_native.so and loaded over JNI (NativeBackend.kt). The WebView in MainActivity talks to it over
// localhost, exactly as the desktop app's window does.

android {
    namespace = "com.bindercardtracker.binder"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.bindercardtracker.binder"
        // 24 is the minimum for the NDK-side libraries (ONNX Runtime's Android package, std::filesystem).
        minSdk = 24
        targetSdk = 34
        // The release build sets BINDER_VERSION (e.g. "v1.0.4"); the version code rises with it so a newer APK can
        // install over an older one. Local builds are 1.0 / 1.
        val releaseVersion = System.getenv("BINDER_VERSION") ?: ""
        val parts = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)$").find(releaseVersion)?.destructured
        versionCode = if (parts != null) {
            parts.component1().toInt() * 1_000_000 + parts.component2().toInt() * 1_000 + parts.component3().toInt()
        } else {
            1
        }
        versionName = if (parts != null) releaseVersion.removePrefix("v") else "1.0"

        ndk {
            // arm64-v8a covers virtually every real device this app would
            // run on; x86_64 is for the emulator. Drop x86_64 to shrink
            // the APK once you're not testing on an emulator anymore.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }

        externalNativeBuild {
            cmake {
                arguments += listOf(
                    "-DANDROID_STL=c++_shared",
                    "-DBINDER_BUILD_TESTS=OFF",
                    "-DBINDER_WITH_VIEW=OFF",      // the WebView is the window here
                    "-DBINDER_STATIC_DEPS=ON",     // OpenCV and SQLite are built from source, statically
                )
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("../../native/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    // Optional fixed signing key (CI passes it in; see BUILDING.md, "Updates"). Without one the debug APK is signed
    // with the machine's throwaway debug key, and Android won't install a newer APK over one signed with another key.
    val keystorePath = System.getenv("BINDER_KEYSTORE_PATH")
    if (!keystorePath.isNullOrEmpty()) {
        signingConfigs {
            create("binder") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("BINDER_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("BINDER_KEY_ALIAS")
                keyPassword = System.getenv("BINDER_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            if (!keystorePath.isNullOrEmpty()) signingConfig = signingConfigs.getByName("binder")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// --- Pull in the existing frontend instead of duplicating it under android/. ------
val repoRoot = rootDir.parentFile

tasks.register<Copy>("copyFrontendAssets") {
    from(repoRoot.resolve("app/index.html"))
    from(repoRoot.resolve("app/css")) { into("css") }
    from(repoRoot.resolve("app/js")) { into("js") }
    into("src/main/assets/frontend")
}

tasks.named("preBuild") {
    dependsOn("copyFrontendAssets")
}

// preBuild.dependsOn above only sequences the Copy task before the build starts — it doesn't tell Gradle that
// AGP's per-variant mergeXAssets task (reads src/main/assets, including our frontend/ subdirectory) reads what
// it wrote to disk. Gradle 8.9's task-validation fails the build over that undeclared dependency rather than
// just risking wrong output, so wire the real dependency directly instead of relying on ordering.
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach {
    dependsOn("copyFrontendAssets")
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.1") // registerForActivityResult
    implementation("androidx.appcompat:appcompat:1.7.0")

    // The ONNX Runtime shared library the detector/OCR/embedder load. The native build links against the same
    // release's headers and libonnxruntime.so (native/cmake/Deps.cmake downloads this AAR itself for that);
    // this dependency is what puts the library into the APK — keep the two versions in step.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.19.2")
}
