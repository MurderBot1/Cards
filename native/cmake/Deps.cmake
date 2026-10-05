# Third-party dependencies shared by the modules, fetched once at configure
# time (pinned). Macros rather than functions so the targets/variables
# FetchContent creates land in the caller's scope.
include(FetchContent)

# Downloaded archives get the time they were extracted at, not the time stored in them (the CMake >= 3.24
# default, set via policy so older CMake — Android Gradle plugins ship 3.22 — doesn't see an unknown keyword).
if(POLICY CMP0135)
    cmake_policy(SET CMP0135 NEW)
endif()

macro(binder_use_json)
    if(NOT TARGET nlohmann_json::nlohmann_json)
        FetchContent_Declare(nlohmann_json
            URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz)
        FetchContent_MakeAvailable(nlohmann_json)
    endif()
endmacro()

macro(binder_use_httplib)
    if(NOT TARGET httplib::httplib)
        # Deterministic build: no optional TLS/compression backends picked up
        # from whatever happens to be installed on the build machine.
        set(HTTPLIB_USE_OPENSSL_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
        set(HTTPLIB_USE_ZLIB_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
        set(HTTPLIB_USE_BROTLI_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
        FetchContent_Declare(httplib
            GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
            GIT_TAG v0.18.7)
        FetchContent_MakeAvailable(httplib)
    endif()
endmacro()

# Release builds link OpenCV and SQLite statically from source instead of using whatever the build machine
# has, so the shipped app doesn't depend on system copies of either.
option(BINDER_STATIC_DEPS "Build OpenCV and SQLite from source and link them statically (release builds)" OFF)

# SQLite: prefer the system library (Linux/macOS have one); otherwise download the
# amalgamation and build it (Windows, Android's NDK).
macro(binder_use_sqlite)
    if(NOT TARGET SQLite::SQLite3)
        if(NOT BINDER_STATIC_DEPS)
            find_package(SQLite3 QUIET)
        endif()
        if(BINDER_STATIC_DEPS OR NOT SQLite3_FOUND)
            FetchContent_Declare(sqlite_amalgamation
                URL https://www.sqlite.org/2024/sqlite-amalgamation-3460000.zip)
            FetchContent_MakeAvailable(sqlite_amalgamation)
            add_library(binder_sqlite3 STATIC ${sqlite_amalgamation_SOURCE_DIR}/sqlite3.c)
            target_include_directories(binder_sqlite3 PUBLIC ${sqlite_amalgamation_SOURCE_DIR})
            find_package(Threads REQUIRED)
            target_link_libraries(binder_sqlite3 PUBLIC Threads::Threads ${CMAKE_DL_LIBS})
            add_library(SQLite::SQLite3 ALIAS binder_sqlite3)
        endif()
    endif()
endmacro()

# OpenCV (core, imgproc, imgcodecs only): the system library if there is one, otherwise a
# pinned minimal static build fetched from git (no GUI/video/ML modules, no optional codecs).
# Exposes the `binder_opencv` target either way.
option(BINDER_FORCE_FETCH_OPENCV "Always build OpenCV from source instead of using a system copy" OFF)
macro(binder_use_opencv)
    if(NOT TARGET binder_opencv)
        if(NOT BINDER_FORCE_FETCH_OPENCV AND NOT BINDER_STATIC_DEPS)
            find_package(OpenCV QUIET COMPONENTS core imgproc imgcodecs)
        endif()
        if(OpenCV_FOUND AND NOT BINDER_FORCE_FETCH_OPENCV AND NOT BINDER_STATIC_DEPS)
            add_library(binder_opencv INTERFACE)
            target_include_directories(binder_opencv SYSTEM INTERFACE ${OpenCV_INCLUDE_DIRS})
            target_link_libraries(binder_opencv INTERFACE ${OpenCV_LIBS})
        else()
            set(BUILD_LIST "core,imgproc,imgcodecs" CACHE STRING "" FORCE)
            set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
            # Match the rest of the project's MSVC runtime (OpenCV defaults to the static one, which would
            # mismatch our /MD objects at link time).
            set(BUILD_WITH_STATIC_CRT OFF CACHE BOOL "" FORCE)
            foreach(opt BUILD_TESTS BUILD_PERF_TESTS BUILD_EXAMPLES BUILD_DOCS BUILD_opencv_apps BUILD_JAVA
                        BUILD_opencv_python2 BUILD_opencv_python3 BUILD_PACKAGE BUILD_WITH_DEBUG_INFO
                        WITH_FFMPEG WITH_GSTREAMER WITH_IPP WITH_ITT WITH_OPENCL WITH_QUIRC WITH_TIFF
                        WITH_WEBP WITH_JASPER WITH_OPENJPEG WITH_OPENEXR WITH_GDAL WITH_PROTOBUF
                        WITH_V4L WITH_GTK WITH_1394 WITH_EIGEN WITH_LAPACK WITH_OPENCLAMDBLAS
                        WITH_OPENCLAMDFFT WITH_CUDA WITH_VTK WITH_ADE WITH_JPEG_PARALLEL WITH_OBSENSOR)
                set(${opt} OFF CACHE BOOL "" FORCE)
            endforeach()
            if(ANDROID)  # only the libraries — not OpenCV's own Android SDK/sample projects or media NDK integration
                foreach(opt BUILD_ANDROID_PROJECTS BUILD_ANDROID_EXAMPLES BUILD_ANDROID_SERVICE
                            WITH_ANDROID_MEDIANDK WITH_ANDROID_NATIVE_CAMERA)
                    set(${opt} OFF CACHE BOOL "" FORCE)
                endforeach()
            endif()
            set(OPENCV_GENERATE_PKGCONFIG OFF CACHE BOOL "" FORCE)
            set(BUILD_PROTOBUF OFF CACHE BOOL "" FORCE)
            FetchContent_Declare(opencv
                GIT_REPOSITORY https://github.com/opencv/opencv.git
                GIT_TAG 4.10.0
                GIT_SHALLOW TRUE)
            FetchContent_MakeAvailable(opencv)
            add_library(binder_opencv INTERFACE)
            target_link_libraries(binder_opencv INTERFACE opencv_core opencv_imgproc opencv_imgcodecs)
            # In-tree OpenCV doesn't export its include paths to consumers outside its own directory.
            target_include_directories(binder_opencv SYSTEM INTERFACE
                ${opencv_SOURCE_DIR}/include
                ${opencv_SOURCE_DIR}/modules/core/include
                ${opencv_SOURCE_DIR}/modules/imgproc/include
                ${opencv_SOURCE_DIR}/modules/imgcodecs/include
                ${CMAKE_BINARY_DIR})
        endif()
    endif()
endmacro()

# ONNX Runtime: a prebuilt release for the host platform, extracted at configure time.
# Sets ONNXRUNTIME_ROOT_DIR (what cardnet's CMake looks for: <root>/include and <root>/lib).
option(BINDER_WITH_ONNX "Build the ONNX Runtime-backed detector/OCR/embedder (downloads a prebuilt ONNX Runtime)" ON)
set(BINDER_ONNXRUNTIME_VERSION "1.19.2" CACHE STRING "ONNX Runtime release to download")
macro(binder_use_onnxruntime)
    if(NOT ONNXRUNTIME_ROOT_DIR AND NOT DEFINED ENV{ONNXRUNTIME_ROOT_DIR})
        if(ANDROID)
            # The official Android package is an AAR (a zip): headers/ and one libonnxruntime.so per ABI under
            # jni/. Reshape it into the <root>/include + <root>/lib layout cardnet's CMake expects, for the
            # ABI being built. (The same library is also packaged into the APK by Gradle, which depends on
            # the same version of the AAR.)
            FetchContent_Declare(onnxruntime_android
                URL https://repo1.maven.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/${BINDER_ONNXRUNTIME_VERSION}/onnxruntime-android-${BINDER_ONNXRUNTIME_VERSION}.aar
                DOWNLOAD_NAME onnxruntime-android.zip)  # so it's recognised as an archive and extracted
            FetchContent_MakeAvailable(onnxruntime_android)
            set(ONNXRUNTIME_ROOT_DIR "${CMAKE_BINARY_DIR}/onnxruntime-root")
            file(MAKE_DIRECTORY "${ONNXRUNTIME_ROOT_DIR}/lib")
            file(COPY "${onnxruntime_android_SOURCE_DIR}/headers/" DESTINATION "${ONNXRUNTIME_ROOT_DIR}/include")
            file(COPY "${onnxruntime_android_SOURCE_DIR}/jni/${ANDROID_ABI}/libonnxruntime.so"
                 DESTINATION "${ONNXRUNTIME_ROOT_DIR}/lib")
        else()
            string(TOLOWER "${CMAKE_SYSTEM_PROCESSOR}" _binder_arch)
            if(WIN32)
                set(_binder_ort_pkg "onnxruntime-win-x64-${BINDER_ONNXRUNTIME_VERSION}.zip")
                if(_binder_arch MATCHES "arm64|aarch64")
                    set(_binder_ort_pkg "onnxruntime-win-arm64-${BINDER_ONNXRUNTIME_VERSION}.zip")
                endif()
            elseif(APPLE)
                if(_binder_arch MATCHES "arm64|aarch64")
                    set(_binder_ort_pkg "onnxruntime-osx-arm64-${BINDER_ONNXRUNTIME_VERSION}.tgz")
                else()
                    set(_binder_ort_pkg "onnxruntime-osx-x86_64-${BINDER_ONNXRUNTIME_VERSION}.tgz")
                endif()
            else()
                if(_binder_arch MATCHES "aarch64|arm64")
                    set(_binder_ort_pkg "onnxruntime-linux-aarch64-${BINDER_ONNXRUNTIME_VERSION}.tgz")
                else()
                    set(_binder_ort_pkg "onnxruntime-linux-x64-${BINDER_ONNXRUNTIME_VERSION}.tgz")
                endif()
            endif()
            FetchContent_Declare(onnxruntime
                URL https://github.com/microsoft/onnxruntime/releases/download/v${BINDER_ONNXRUNTIME_VERSION}/${_binder_ort_pkg})
            FetchContent_MakeAvailable(onnxruntime)
            set(ONNXRUNTIME_ROOT_DIR "${onnxruntime_SOURCE_DIR}")
        endif()
    endif()
endmacro()

# webview/webview: the native window + system web view (WebKitGTK / WKWebView / WebView2).
option(BINDER_WITH_VIEW "Build the native window (cardview) and open it from binder" ON)
macro(binder_use_webview)
    if(NOT TARGET webview::core_static)
        set(WEBVIEW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
        set(WEBVIEW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(WEBVIEW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
        set(WEBVIEW_INSTALL_DOCS OFF CACHE BOOL "" FORCE)
        set(WEBVIEW_INSTALL_TARGETS OFF CACHE BOOL "" FORCE)
        set(WEBVIEW_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
        set(WEBVIEW_BUILD_STATIC_LIBRARY ON CACHE BOOL "" FORCE)
        set(WEBVIEW_ENABLE_CHECKS OFF CACHE BOOL "" FORCE)
        set(WEBVIEW_ENABLE_PACKAGING OFF CACHE BOOL "" FORCE)
        FetchContent_Declare(webview
            GIT_REPOSITORY https://github.com/webview/webview.git
            GIT_TAG 0.12.0
            GIT_SHALLOW TRUE)
        FetchContent_MakeAvailable(webview)
    endif()
endmacro()
