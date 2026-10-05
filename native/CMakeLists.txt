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
add_subdirectory(cardscan)
add_subdirectory(binder)
