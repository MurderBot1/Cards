# ONNX Runtime from NuGet. The GitHub releases the build used to download (github.com/microsoft/onnxruntime) no longer exist, but
# the Microsoft.ML.OnnxRuntime package on nuget.org is still served and holds the same C/C++ headers and the shared library for each
# desktop platform. A .nupkg is a zip: this turns the extracted package into the <root>/include + <root>/lib layout the rest of the
# build (cardnet, the installer, the Windows DLL copy) expects from an onnxruntime-<platform> release.
#
#   binder_ort_from_nuget(<extracted package dir> <version> <rid> <root dir>)
# `rid` is the NuGet runtime id: linux-x64, linux-arm64, osx-arm64, osx-x86_64, win-x64, win-arm64.
function(binder_ort_from_nuget package_dir version rid root_dir)
    set(_native "${package_dir}/runtimes/${rid}/native")
    if(NOT IS_DIRECTORY "${_native}")
        file(GLOB _rids RELATIVE "${package_dir}/runtimes" "${package_dir}/runtimes/*")
        message(FATAL_ERROR "The ONNX Runtime ${version} NuGet package has no runtimes/${rid} (it has: ${_rids})")
    endif()
    file(GLOB _headers "${package_dir}/build/native/include/*.h")
    if(NOT _headers)
        message(FATAL_ERROR "No ONNX Runtime headers under ${package_dir}/build/native/include")
    endif()
    file(REMOVE_RECURSE "${root_dir}")
    file(MAKE_DIRECTORY "${root_dir}/include" "${root_dir}/lib")
    file(COPY ${_headers} DESTINATION "${root_dir}/include")
    file(GLOB _libs "${_native}/*")
    file(COPY ${_libs} DESTINATION "${root_dir}/lib")

    # The packages name the shared library plainly; the releases it replaces also carried the versioned names the loader looks for
    # (libonnxruntime.so.1.19.2 / .so.1, libonnxruntime.1.19.2.dylib), so provide those as copies.
    string(REGEX MATCH "^[0-9]+" _major "${version}")
    if(EXISTS "${root_dir}/lib/libonnxruntime.so")
        configure_file("${root_dir}/lib/libonnxruntime.so" "${root_dir}/lib/libonnxruntime.so.${version}" COPYONLY)
        configure_file("${root_dir}/lib/libonnxruntime.so" "${root_dir}/lib/libonnxruntime.so.${_major}" COPYONLY)
    endif()
    if(EXISTS "${root_dir}/lib/libonnxruntime.dylib")
        configure_file("${root_dir}/lib/libonnxruntime.dylib" "${root_dir}/lib/libonnxruntime.${version}.dylib" COPYONLY)
    endif()
    if(NOT EXISTS "${root_dir}/lib/libonnxruntime.so" AND NOT EXISTS "${root_dir}/lib/libonnxruntime.dylib" AND NOT EXISTS "${root_dir}/lib/onnxruntime.lib")
        message(FATAL_ERROR "No ONNX Runtime library in ${_native}")
    endif()
endfunction()
