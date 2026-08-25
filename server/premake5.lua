-- premake5.lua
-- -----------------------------------------------------------------
-- Run `premake5 gmake2` (Linux/Mac) or `premake5 vs2022` (Windows)
-- from the project root. All generated project/build files (the
-- Makefile / .sln+.vcxproj, .obj files, and compiled binaries) land
-- under build/ — nothing is written next to the source.
-- -----------------------------------------------------------------
workspace "Server"
    configurations { "Debug", "Release" }
    location "build"

project "Server"
    kind "ConsoleApp"
    language "C++"
    cppdialect "C++17"
    toolset "gcc"

    targetdir "build/bin/%{cfg.buildcfg}"
    objdir "build/obj/%{cfg.buildcfg}"

    includedirs { "include" }
    files {
        "include/**.h",
        "src/**.cpp"
    }

    filter "system:linux"
        links { "pthread" }

    filter "system:windows"
        links { "ws2_32" }       -- Winsock2, used by PlatformSocket.cpp
        defines { "_WIN32_WINNT=0x0601" }  -- Windows 7+, needed by ws2tcpip.h (inet_ntop etc.)

    filter "configurations:Debug"
        defines { "DEBUG" }
        symbols "On"

    filter "configurations:Release"
        defines { "NDEBUG" }
        optimize "On"