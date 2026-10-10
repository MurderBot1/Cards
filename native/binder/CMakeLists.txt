find_package(Threads REQUIRED)

# The API: every endpoint js/api.js expects, as a function that registers
# routes on a cardhttp::Server. A library (not just part of main) so the tests
# can drive it end to end over real HTTP.
add_library(binder_api STATIC src/api.cpp src/open_url.cpp src/sha256.cpp src/updater.cpp src/save_file.cpp)
target_include_directories(binder_api PUBLIC src)
target_link_libraries(binder_api PUBLIC cardhttp cardstore cardauth cardscan cardlog carddownload)
if(WIN32)
    target_link_libraries(binder_api PRIVATE shell32)  # ShellExecute, for opening a download in the browser
endif()

# The assembled backend (store + engine + server + routes), shared by the desktop app and the Android library.
add_library(binder_app STATIC src/app.cpp)
target_include_directories(binder_app PUBLIC src)
target_link_libraries(binder_app PUBLIC binder_api cardpaths cardscan)
# First-run download of the catalog. The desktop builds fetch with libcurl when it's available; Android supplies its
# own transport through AppOptions::make_transport (HttpURLConnection, see binder_android).
target_link_libraries(binder_app PUBLIC carddownload)
if(TARGET cardfetch_curl)
    target_link_libraries(binder_app PUBLIC cardfetch_curl)
    target_compile_definitions(binder_app PUBLIC BINDER_HAVE_CURL_TRANSPORT=1)
endif()
if(TARGET cardonnx)
    target_link_libraries(binder_app PUBLIC cardonnx)
    target_compile_definitions(binder_app PRIVATE BINDER_HAVE_ONNX=1)
endif()

if(BINDER_BUILD_TESTS)
    add_executable(binder_app_test tests/test_app.cpp)
    target_link_libraries(binder_app_test PRIVATE binder_app cardpaths cardtest)
    target_include_directories(binder_app_test PRIVATE ${httplib_SOURCE_DIR})
    target_compile_definitions(binder_app_test PRIVATE BINDER_REPO_APP_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../app")
    if(TARGET cardonnx)
        binder_copy_onnxruntime_dlls(binder_app_test)
    endif()
    add_test(NAME binder_app COMMAND binder_app_test)
    set_tests_properties(binder_app PROPERTIES TIMEOUT 60)

    add_executable(binder_api_test tests/test_api.cpp)
    target_link_libraries(binder_api_test PRIVATE binder_api cardpaths cardtest)
    target_include_directories(binder_api_test PRIVATE ${httplib_SOURCE_DIR})
    target_compile_definitions(binder_api_test PRIVATE BINDER_REPO_APP_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../app")
    add_test(NAME binder_api COMMAND binder_api_test)
    set_tests_properties(binder_api PROPERTIES TIMEOUT 60)
endif()


# The desktop app (Android builds the JNI library in ../binder_android, iOS the app in ../binder_ios instead).
if(NOT ANDROID AND NOT IOS)
    add_executable(binder src/main.cpp)
    if(TARGET cardonnx)
        binder_copy_onnxruntime_dlls(binder)
    endif()
    if(WIN32)
        target_sources(binder PRIVATE packaging/binder.rc)
    endif()
    target_link_libraries(binder PRIVATE binder_app cardpaths cardlog Threads::Threads)
    if(TARGET cardview)
        target_link_libraries(binder PRIVATE cardview)
        target_compile_definitions(binder PRIVATE BINDER_HAVE_VIEW=1)
    endif()
    if(WIN32)
        # A GUI-subsystem executable, so launching it doesn't pop up a console window (errors go to startup.log).
        set_target_properties(binder PROPERTIES WIN32_EXECUTABLE ON)
        if(MSVC)
            target_link_options(binder PRIVATE /ENTRY:mainCRTStartup)
        endif()
    endif()


    # ---------------------------------------------------------------------------
    # Packaging: `cmake --install <build> --component binder --prefix <dir>` lays the app out the way it is shipped.
    # Zip the result. (The component keeps the downloaded dependencies' own install rules out of it.)
    #
    #   Windows / Linux:  Binder/{binder[.exe], frontend/, [data/], ONNX Runtime libs (+ the MSVC runtime on Windows)}
    #   macOS:            Binder.app/Contents/{MacOS/binder, Resources/{frontend, [data], icon.icns}, Frameworks/, Info.plist}
    #
    # cardpaths looks for frontend/ next to the executable (or in Resources/ inside the .app) and for a catalog
    # shipped next to it as data/; anything the app writes goes to the per-user data directory, never here.
    # Files placed in packaging/bundled_data/ (besides its README) are shipped as that catalog.
    # ---------------------------------------------------------------------------
    set(BINDER_APP_SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/../../app")  # index.html, css/, js/

    if(APPLE)
        set(_app "Binder.app/Contents")
        set(_frontend_dest "${_app}/Resources/frontend")
        set(_data_dest "${_app}/Resources/data")
        set_target_properties(binder PROPERTIES INSTALL_RPATH "@executable_path/../Frameworks")
        install(TARGETS binder RUNTIME DESTINATION "${_app}/MacOS" COMPONENT binder)
        configure_file(packaging/Info.plist.in "${CMAKE_CURRENT_BINARY_DIR}/Info.plist" @ONLY)
        install(FILES "${CMAKE_CURRENT_BINARY_DIR}/Info.plist" DESTINATION "${_app}" COMPONENT binder)
        install(FILES packaging/icons/icon.icns DESTINATION "${_app}/Resources" COMPONENT binder)
        set(_ort_dest "${_app}/Frameworks")
        set(_ort_pattern "*.dylib")
    else()
        set(_frontend_dest "Binder/frontend")
        set(_data_dest "Binder/data")
        install(TARGETS binder RUNTIME DESTINATION Binder COMPONENT binder)
        set(_ort_dest "Binder")
        if(WIN32)
            set(_ort_pattern "*.dll")
            # onnxruntime.dll needs the Visual C++ runtime, which a clean machine may not have.
            set(CMAKE_INSTALL_SYSTEM_RUNTIME_DESTINATION "Binder")
            set(CMAKE_INSTALL_UCRT_LIBRARIES TRUE)
            set(CMAKE_INSTALL_SYSTEM_RUNTIME_COMPONENT binder)
            include(InstallRequiredSystemLibraries)
        else()
            set(_ort_pattern "*.so*")
            set_target_properties(binder PROPERTIES INSTALL_RPATH "$ORIGIN")
        endif()
    endif()

    install(FILES "${BINDER_APP_SOURCE}/index.html" DESTINATION "${_frontend_dest}" COMPONENT binder)
    install(DIRECTORY "${BINDER_APP_SOURCE}/css" "${BINDER_APP_SOURCE}/js" DESTINATION "${_frontend_dest}" COMPONENT binder)

    if(ONNXRUNTIME_ROOT_DIR)  # the shared library the detector/OCR/embedder load at run time
        install(DIRECTORY "${ONNXRUNTIME_ROOT_DIR}/lib/" DESTINATION "${_ort_dest}" COMPONENT binder
                FILES_MATCHING PATTERN "${_ort_pattern}"
                PATTERN "cmake" EXCLUDE PATTERN "pkgconfig" EXCLUDE)  # (the release also ships CMake/pkg-config files)
    endif()

    file(GLOB _bundled_data "${CMAKE_CURRENT_SOURCE_DIR}/packaging/bundled_data/*")
    list(FILTER _bundled_data EXCLUDE REGEX "README\\.md$")
    if(_bundled_data)
        install(DIRECTORY packaging/bundled_data/ DESTINATION "${_data_dest}" COMPONENT binder PATTERN "README.md" EXCLUDE)
    endif()

endif()
