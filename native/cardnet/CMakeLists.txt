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

find_path(ONNXRUNTIME_INCLUDE_DIR onnxruntime_cxx_api.h PATHS "${ONNXRUNTIME_ROOT_DIR}/include" NO_DEFAULT_PATH)
find_library(ONNXRUNTIME_LIB NAMES onnxruntime PATHS "${ONNXRUNTIME_ROOT_DIR}/lib" NO_DEFAULT_PATH)
if(NOT ONNXRUNTIME_INCLUDE_DIR OR NOT ONNXRUNTIME_LIB)
    message(FATAL_ERROR "Could not find ONNX Runtime headers/library under ONNXRUNTIME_ROOT_DIR=${ONNXRUNTIME_ROOT_DIR}")
endif()

add_library(onnxruntime_imported SHARED IMPORTED)
set_target_properties(onnxruntime_imported PROPERTIES
    IMPORTED_LOCATION "${ONNXRUNTIME_LIB}"
    INTERFACE_INCLUDE_DIRECTORIES "${ONNXRUNTIME_INCLUDE_DIR}"
)
if(WIN32)
    # .lib here is an import library; the matching .dll must be next to
    # whatever executable/extension module ends up loading it at runtime
    # (copied automatically for the pybind11 module below).
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
    # Since Python 3.8, Windows no longer searches PATH for a C extension
    # module's dependent DLLs at import time (only the app/system32/
    # add_dll_directory() locations) — so a MinGW-built module must not
    # depend on MinGW's own runtime DLLs (libstdc++-6.dll, libgcc_s_seh-1.dll,
    # libwinpthread-1.dll) being reachable at all; statically linking them
    # in is the standard fix. Irrelevant for MSVC/clang builds.
    target_link_options(cardnet_core PUBLIC -static-libgcc -static-libstdc++ -static -lwinpthread)
endif()

find_package(Threads REQUIRED)
target_link_libraries(cardnet_core PUBLIC Threads::Threads)

# ---------------------------------------------------------------------------
# Python bindings (pybind11) — same discovery pattern as native/cardvec.
# ---------------------------------------------------------------------------
option(CARDNET_BUILD_PYTHON "Build the pybind11 Python extension module" ON)
if(CARDNET_BUILD_PYTHON)
    if(NOT DEFINED Python3_EXECUTABLE AND DEFINED CARDNET_PYTHON_EXECUTABLE)
        set(Python3_EXECUTABLE "${CARDNET_PYTHON_EXECUTABLE}")
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

    pybind11_add_module(cardnet python/bindings.cpp)
    target_link_libraries(cardnet PRIVATE cardnet_core)

    if(WIN32)
        # onnxruntime.dll must sit next to the built .pyd to load at import
        # time; copy it automatically so `import cardnet` works straight out
        # of the build directory without a manual PATH/copy step.
        get_filename_component(ONNXRUNTIME_LIB_DIR "${ONNXRUNTIME_LIB}" DIRECTORY)
        file(GLOB ONNXRUNTIME_SHARED_LIBS "${ONNXRUNTIME_LIB_DIR}/*.dll")
    else()
        get_filename_component(ONNXRUNTIME_LIB_DIR "${ONNXRUNTIME_LIB}" DIRECTORY)
        file(GLOB ONNXRUNTIME_SHARED_LIBS "${ONNXRUNTIME_LIB_DIR}/*.so*" "${ONNXRUNTIME_LIB_DIR}/*.dylib*")
    endif()
    add_custom_command(TARGET cardnet POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different ${ONNXRUNTIME_SHARED_LIBS} "$<TARGET_FILE_DIR:cardnet>"
    )
    # Also install it into the wheel next to the compiled module (scikit-
    # build-core installs "." as the package root) — needed so a packaged
    # desktop build (PyInstaller's collect_all("cardnet")) finds it too,
    # not just a from-source build directory.
    install(FILES ${ONNXRUNTIME_SHARED_LIBS} DESTINATION .)
endif()

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
