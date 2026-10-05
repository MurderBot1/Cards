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
