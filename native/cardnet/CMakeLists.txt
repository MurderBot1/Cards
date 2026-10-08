cmake_minimum_required(VERSION 3.18)
project(cardnet LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif()

# ---------------------------------------------------------------------------
# Locate ONNX Runtime. Point -DONNXRUNTIME_ROOT_DIR at an extracted
# onnxruntime-<platform>-<version> release (from
# https://github.com/microsoft/onnxruntime/releases) — its layout is
# always <root>/include and <root>/lib. See README.md for the exact
# desktop and Android download/build steps.
# ---------------------------------------------------------------------------
if(NOT ONNXRUNTIME_ROOT_DIR)
    if(DEFINED ENV{ONNXRUNTIME_ROOT_DIR})
        set(ONNXRUNTIME_ROOT_DIR "$ENV{ONNXRUNTIME_ROOT_DIR}")
    else()
        message(FATAL_ERROR
            "ONNXRUNTIME_ROOT_DIR is not set. Pass -DONNXRUNTIME_ROOT_DIR=/path/to/onnxruntime-<platform>-<version> "
            "(the extracted release directory containing include/ and lib/) or set it as an environment variable. "
            "See native/cardnet/README.md.")
    endif()
endif()

# NO_CMAKE_FIND_ROOT_PATH: the Android NDK toolchain restricts find_path/find_library to its own sysroot unless told
# otherwise, which would hide a directory like this one.
find_path(ONNXRUNTIME_INCLUDE_DIR onnxruntime_cxx_api.h PATHS "${ONNXRUNTIME_ROOT_DIR}/include" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
find_library(ONNXRUNTIME_LIB NAMES onnxruntime PATHS "${ONNXRUNTIME_ROOT_DIR}/lib" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
if(NOT ONNXRUNTIME_INCLUDE_DIR OR NOT ONNXRUNTIME_LIB)
    message(FATAL_ERROR "Could not find ONNX Runtime headers/library under ONNXRUNTIME_ROOT_DIR=${ONNXRUNTIME_ROOT_DIR}")
endif()

# (On iOS the library is a static archive, so what it needs from the system comes with it.)
add_library(onnxruntime_imported SHARED IMPORTED)
set_target_properties(onnxruntime_imported PROPERTIES
    IMPORTED_LOCATION "${ONNXRUNTIME_LIB}"
    INTERFACE_INCLUDE_DIRECTORIES "${ONNXRUNTIME_INCLUDE_DIR}"
)
if(IOS)
    set_property(TARGET onnxruntime_imported APPEND PROPERTY INTERFACE_LINK_LIBRARIES
        "-framework Foundation" "-framework CoreML" "-framework Accelerate")
endif()
if(WIN32)
    # .lib here is an import library; the matching .dll must be next to
    # whatever executable ends up loading it at runtime (binder's build copies it there).
    set_target_properties(onnxruntime_imported PROPERTIES IMPORTED_IMPLIB "${ONNXRUNTIME_LIB}")
endif()

# ---------------------------------------------------------------------------
# Core library.
# ---------------------------------------------------------------------------
add_library(cardnet_core STATIC
    src/nms.cpp
    src/ctc_decode.cpp
    src/geometry.cpp
    src/db_postprocess.cpp
    src/ort_session.cpp
    src/dino_embedder.cpp
    src/yolo_detector.cpp
    src/ocr_pipeline.cpp
)
target_include_directories(cardnet_core PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)
target_link_libraries(cardnet_core PUBLIC onnxruntime_imported)

if(WIN32 AND CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    # A MinGW-built program shouldn't depend on MinGW's own runtime DLLs
    # (libstdc++-6.dll, libgcc_s_seh-1.dll, libwinpthread-1.dll) being
    # reachable on the user's machine; statically linking them in is the
    # standard fix. Irrelevant for MSVC/clang builds.
    target_link_options(cardnet_core PUBLIC -static-libgcc -static-libstdc++ -static -lwinpthread)
endif()

find_package(Threads REQUIRED)
target_link_libraries(cardnet_core PUBLIC Threads::Threads)

# ---------------------------------------------------------------------------
# Tests.
# ---------------------------------------------------------------------------
option(CARDNET_BUILD_TESTS "Build the standalone C++ test executables" OFF)
if(CARDNET_BUILD_TESTS)
    add_executable(cardnet_pure_test tests/test_pure_cpp.cpp
        src/nms.cpp src/ctc_decode.cpp src/geometry.cpp src/db_postprocess.cpp)
    target_include_directories(cardnet_pure_test PRIVATE include)

    add_executable(cardnet_ort_smoke_test tests/test_ort_smoke.cpp)
    target_link_libraries(cardnet_ort_smoke_test PRIVATE cardnet_core)
endif()
