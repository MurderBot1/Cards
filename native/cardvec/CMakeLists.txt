cmake_minimum_required(VERSION 3.18)
project(cardvec LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif()

# ---------------------------------------------------------------------------
# Core library: no Python dependency at all, so this half cross-compiles for
# Android with nothing but the NDK's own clang (see README.md).
# ---------------------------------------------------------------------------
add_library(cardvec_core STATIC
    src/flat_index.cpp
)
target_include_directories(cardvec_core PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
)

include(CheckCXXCompilerFlag)
if(ANDROID_ABI STREQUAL "arm64-v8a" OR CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
    # NEON is baseline on arm64 — no flag needed, dot.hpp detects __ARM_NEON.
elseif(ANDROID_ABI MATCHES "^x86" OR CMAKE_SYSTEM_PROCESSOR MATCHES "x86_64|AMD64|i686")
    check_cxx_compiler_flag("-mavx2 -mfma" CARDVEC_HAS_AVX2)
    if(CARDVEC_HAS_AVX2)
        target_compile_options(cardvec_core PRIVATE -mavx2 -mfma)
    endif()
endif()
if(MSVC)
    target_compile_options(cardvec_core PRIVATE /O2)
    check_cxx_compiler_flag("/arch:AVX2" CARDVEC_HAS_MSVC_AVX2)
    if(CARDVEC_HAS_MSVC_AVX2 AND NOT (CMAKE_SYSTEM_PROCESSOR MATCHES "ARM|arm"))
        target_compile_options(cardvec_core PRIVATE /arch:AVX2)
    endif()
endif()

find_package(Threads REQUIRED)
target_link_libraries(cardvec_core PUBLIC Threads::Threads)

if(WIN32 AND CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    # Since Python 3.8, Windows no longer searches PATH for a C extension
    # module's dependent DLLs at import time (only the app/system32/
    # add_dll_directory() locations) — so a MinGW-built module must not
    # depend on MinGW's own runtime DLLs (libstdc++-6.dll, libgcc_s_seh-1.dll,
    # libwinpthread-1.dll) being reachable at all; statically linking them
    # in is the standard fix. Irrelevant for MSVC/clang builds.
    target_link_options(cardvec_core PUBLIC -static-libgcc -static-libstdc++ -static -lwinpthread)
endif()

# ---------------------------------------------------------------------------
# Python bindings (pybind11). Default ON for desktop builds; when
# cross-compiling for Android you almost always want this OFF (see
# README.md) unless CARDVEC_PYTHON_EXECUTABLE points at a cross-built
# CPython (e.g. Chaquopy's), in which case leave it ON.
# ---------------------------------------------------------------------------
option(CARDVEC_BUILD_PYTHON "Build the pybind11 Python extension module" ON)
if(CARDVEC_BUILD_PYTHON)
    if(NOT DEFINED Python3_EXECUTABLE AND DEFINED CARDVEC_PYTHON_EXECUTABLE)
        set(Python3_EXECUTABLE "${CARDVEC_PYTHON_EXECUTABLE}")
    endif()
    find_package(Python3 REQUIRED COMPONENTS Interpreter Development.Module)

    find_package(pybind11 CONFIG QUIET)
    if(NOT pybind11_FOUND)
        execute_process(
            COMMAND "${Python3_EXECUTABLE}" -m pybind11 --cmakedir
            OUTPUT_VARIABLE _pybind11_cmake_dir
            OUTPUT_STRIP_TRAILING_WHITESPACE
            RESULT_VARIABLE _pybind11_find_result
        )
        if(NOT _pybind11_find_result EQUAL 0)
            message(FATAL_ERROR
                "pybind11 not found. Install it for ${Python3_EXECUTABLE} with "
                "`pip install pybind11`, or set -Dpybind11_DIR=... yourself.")
        endif()
        list(APPEND CMAKE_PREFIX_PATH "${_pybind11_cmake_dir}")
        find_package(pybind11 CONFIG REQUIRED)
    endif()

    pybind11_add_module(cardvec python/bindings.cpp)
    target_link_libraries(cardvec PRIVATE cardvec_core)
endif()

# ---------------------------------------------------------------------------
# Plain C++ sanity test (no Python involved) — useful when cross-compiling
# for Android to smoke-test the core lib on-device/on-emulator without a
# Python runtime in the loop at all.
# ---------------------------------------------------------------------------
option(CARDVEC_BUILD_TESTS "Build the standalone C++ self-test executable" OFF)
if(CARDVEC_BUILD_TESTS)
    add_executable(cardvec_selftest tests/test_flat_index.cpp)
    target_link_libraries(cardvec_selftest PRIVATE cardvec_core)
endif()
