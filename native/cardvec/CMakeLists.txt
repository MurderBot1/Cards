cmake_minimum_required(VERSION 3.18)
project(cardvec LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif()

# ---------------------------------------------------------------------------
# Core library: no dependencies at all, so it cross-compiles for Android with
# nothing but the NDK's own clang (see README.md).
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
    # A MinGW-built program shouldn't depend on MinGW's own runtime DLLs
    # (libstdc++-6.dll, libgcc_s_seh-1.dll, libwinpthread-1.dll) being
    # reachable on the user's machine; statically linking them in is the
    # standard fix. Irrelevant for MSVC/clang builds.
    target_link_options(cardvec_core PUBLIC -static-libgcc -static-libstdc++ -static -lwinpthread)
endif()

# ---------------------------------------------------------------------------
# Plain C++ self-test — also useful when cross-compiling for Android, to
# smoke-test the core lib on a device/emulator.
# ---------------------------------------------------------------------------
option(CARDVEC_BUILD_TESTS "Build the standalone C++ self-test executable" OFF)
if(CARDVEC_BUILD_TESTS)
    add_executable(cardvec_selftest tests/test_flat_index.cpp)
    target_link_libraries(cardvec_selftest PRIVATE cardvec_core)
endif()
