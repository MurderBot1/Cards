plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

android {
    namespace = "com.bindercardtracker.binder"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.bindercardtracker.binder"
        // Chaquopy requires minSdk >= 24 — see native/cardnet and
        // native/cardvec's own Android notes for the NDK-side minimum
        // (android-24), which matches.
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        ndk {
            // arm64-v8a covers virtually every real device this app would
            // run on; x86_64 is for the emulator. Drop x86_64 to shrink
            // the APK once you're not testing on an emulator anymore.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
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

chaquopy {
    defaultConfig {
        // 3.10, not a newer Python, and not Chaquopy's default-by-accident:
        // this is pinned by opencv-python. Chaquopy serves native packages
        // from its own repository (https://chaquo.com/pypi-13.1/) rather
        // than PyPI, and the newest opencv-python it publishes there is
        // 4.5.1.48, whose highest wheel tag is cp310. numpy is available
        // for 3.10 through 3.13, so cp310 is the only Python version where
        // both resolve — and app.py/scanner.py import cv2 at module scope.
        //
        // Consequence for whoever builds this: Chaquopy requires a build
        // machine Python matching the app's, so you need Python 3.10 on
        // PATH (or set `buildPython`) even though nothing else here does.
        version = "3.10"

        pip {
            // Pure Python — installed from PyPI as normal.
            install("flask")
            install("platformdirs")

            // Native, from Chaquopy's own package repository.
            install("numpy")
            install("opencv-python")

            // NOT listed, deliberately: duckdb and rapidfuzz. Neither
            // appears in Chaquopy's native repository at any Python
            // version and neither publishes an Android wheel, so both were
            // removed from the app rather than worked around — the card
            // catalog is now stdlib sqlite3 (build_scanner_models.get_db)
            // and fuzzy title matching is stdlib difflib
            // (scanner._title_candidates). Don't add them back here; they
            // will not resolve.

            // cardvec / cardnet: not on PyPI at all, and need a wheel
            // cross-compiled against Chaquopy's own bundled Python — see
            // android/README.md and native/cardvec|cardnet/README.md.
            // Uncomment once you've built them (note cp310, matching the
            // version pinned above):
            // install("libs/cardvec-1.0.0-cp310-cp310-android_24_arm64_v8a.whl")
            // install("libs/cardnet-1.0.0-cp310-cp310-android_24_arm64_v8a.whl")
        }
    }
}

// --- Pull in the existing frontend + backend source instead of
//     duplicating it under android/ — see android/README.md for why
//     these are Copy tasks rather than Chaquopy sourceSets/symlinks. ------
val repoRoot = rootDir.parentFile
val backendDir = repoRoot.resolve("app/backend")

tasks.register<Copy>("copyFrontendAssets") {
    from(repoRoot.resolve("app/index.html"))
    from(repoRoot.resolve("app/css")) { into("css") }
    from(repoRoot.resolve("app/js")) { into("js") }
    into("src/main/assets/frontend")
}

tasks.register<Copy>("copyPythonBackend") {
    // Only the three modules android_main.py actually imports — not
    // build_scanner_models.py (a dev-only tool with its own heavy
    // dependencies) and not data/db.json/logs/__pycache__ (gitignored,
    // per-run state that doesn't belong in an APK).
    from(backendDir) {
        include("app.py", "scanner.py", "paths.py")
    }
    into("src/main/python")
}

tasks.named("preBuild") {
    dependsOn("copyFrontendAssets", "copyPythonBackend")
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.1") // registerForActivityResult
    implementation("androidx.appcompat:appcompat:1.7.0")
}
