// Root build file — declares plugin versions once; each module applies
// what it needs without repeating a version (see app/build.gradle.kts).
// Versions here are what was current when this was written — bump them
// to match whatever Android Studio/AGP you're building with if Gradle
// complains about an incompatible combination; see android/README.md.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    id("com.chaquo.python") version "17.0.0" apply false
}
