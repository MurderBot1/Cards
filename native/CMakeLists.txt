cmake_minimum_required(VERSION 3.18)
project(binder_native LANGUAGES CXX)

# Superbuild for Binder's C++ modules (cardvec/cardnet are the older ones and
# stay standalone-buildable). Each module is a small library with its own
# tests; `binder` is the app that wires them together.
#
#   cmake -S native -B build && cmake --build build && ctest --test-dir build
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release)
endif()

option(BINDER_BUILD_TESTS "Build the modules' test executables" ON)
if(BINDER_BUILD_TESTS)
    enable_testing()
endif()

include(cmake/Deps.cmake)

add_subdirectory(cardtest)
add_subdirectory(cardlog)
add_subdirectory(cardpaths)
add_subdirectory(cardstore)
add_subdirectory(cardhttp)
add_subdirectory(cardauth)
add_subdirectory(cardtext)
add_subdirectory(cardcatalog)

# cardvec is the older, standalone-buildable module; here we only want its core library (the Python
# bindings are for the pip package, built separately).
set(CARDVEC_BUILD_PYTHON OFF CACHE BOOL "" FORCE)
set(CARDVEC_BUILD_TESTS ${BINDER_BUILD_TESTS} CACHE BOOL "" FORCE)
add_subdirectory(cardvec)
if(BINDER_BUILD_TESTS)
    add_test(NAME cardvec COMMAND cardvec_selftest)
endif()

add_subdirectory(cardscan)

# The ONNX Runtime-backed models (YOLO detector, OCR, art embedder). Needs a prebuilt ONNX Runtime, downloaded
# at configure time; configure with -DBINDER_WITH_ONNX=OFF to build without (scans then skip those stages).
if(BINDER_WITH_ONNX)
    binder_use_onnxruntime()
    set(CARDNET_BUILD_PYTHON OFF CACHE BOOL "" FORCE)
    set(CARDNET_BUILD_TESTS ${BINDER_BUILD_TESTS} CACHE BOOL "" FORCE)
    add_subdirectory(cardnet)
    if(BINDER_BUILD_TESTS)
        add_test(NAME cardnet_pure COMMAND cardnet_pure_test)  # (the ORT smoke test needs a model file argument)
    endif()
    add_subdirectory(cardonnx)
endif()
# The native window. Needs the platform's web view libraries (WebKitGTK + GTK on Linux); configure with
# -DBINDER_WITH_VIEW=OFF for a build without a window (binder then only serves, like --headless).
if(BINDER_WITH_VIEW)
    add_subdirectory(cardview)
endif()

add_subdirectory(binder)
