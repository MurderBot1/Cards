# Third-party dependencies shared by the modules, fetched once at configure
# time (pinned). Macros rather than functions so the targets/variables
# FetchContent creates land in the caller's scope.
include(FetchContent)

macro(binder_use_json)
    if(NOT TARGET nlohmann_json::nlohmann_json)
        FetchContent_Declare(nlohmann_json
            URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
            DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
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

# SQLite: prefer the system library (Linux/macOS have one); otherwise download the
# amalgamation and build it (Windows, Android's NDK).
macro(binder_use_sqlite)
    if(NOT TARGET SQLite::SQLite3)
        find_package(SQLite3 QUIET)
        if(NOT SQLite3_FOUND)
            FetchContent_Declare(sqlite_amalgamation
                URL https://www.sqlite.org/2024/sqlite-amalgamation-3460000.zip
                DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
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
        if(NOT BINDER_FORCE_FETCH_OPENCV)
            find_package(OpenCV QUIET COMPONENTS core imgproc imgcodecs)
        endif()
        if(OpenCV_FOUND AND NOT BINDER_FORCE_FETCH_OPENCV)
            add_library(binder_opencv INTERFACE)
            target_include_directories(binder_opencv SYSTEM INTERFACE ${OpenCV_INCLUDE_DIRS})
            target_link_libraries(binder_opencv INTERFACE ${OpenCV_LIBS})
        else()
            set(BUILD_LIST "core,imgproc,imgcodecs" CACHE STRING "" FORCE)
            set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
            foreach(opt BUILD_TESTS BUILD_PERF_TESTS BUILD_EXAMPLES BUILD_DOCS BUILD_opencv_apps BUILD_JAVA
                        BUILD_opencv_python2 BUILD_opencv_python3 BUILD_PACKAGE BUILD_WITH_DEBUG_INFO
                        WITH_FFMPEG WITH_GSTREAMER WITH_IPP WITH_ITT WITH_OPENCL WITH_QUIRC WITH_TIFF
                        WITH_WEBP WITH_JASPER WITH_OPENJPEG WITH_OPENEXR WITH_GDAL WITH_PROTOBUF
                        WITH_V4L WITH_GTK WITH_1394 WITH_EIGEN WITH_LAPACK WITH_OPENCLAMDBLAS
                        WITH_OPENCLAMDFFT WITH_CUDA WITH_VTK WITH_ADE WITH_JPEG_PARALLEL)
                set(${opt} OFF CACHE BOOL "" FORCE)
            endforeach()
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
