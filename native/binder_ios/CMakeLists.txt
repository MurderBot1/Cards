# Binder.app for iOS: a WKWebView pointed at the same C++ backend the desktop and Android apps run (store, recognition,
# HTTP server on localhost), serving the same frontend. Built by the same superbuild:
#
#   cmake -S native -B build-ios -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphoneos -DCMAKE_OSX_ARCHITECTURES=arm64 \
#         -DBINDER_STATIC_DEPS=ON -DBINDER_WITH_VIEW=OFF -DBINDER_WITH_CATALOG_TOOL=OFF -DBINDER_BUILD_TESTS=OFF
#   cmake --build build-ios --target binder_ios        # -> build-ios/bin/Binder.app (unsigned; see BUILDING.md)
#
# The bundle is flat (iOS has no Contents/): the executable, Info.plist and icons at the top, frontend/ (index.html, css/,
# js/) and, when native/binder/packaging/bundled_data has files, data/ (the models) next to them — the layout cardpaths
# already looks for next to the executable.
set(BINDER_IOS_VERSION "1.0.0" CACHE STRING "CFBundleShortVersionString: the release version without the leading v")
set(BINDER_IOS_BUILD "1" CACHE STRING "CFBundleVersion: a number that rises with every release")

add_executable(binder_ios MACOSX_BUNDLE
    src/main.mm
    src/AppDelegate.mm
    src/BinderViewController.mm
    src/Backend.mm
    src/UrlSessionTransport.mm)
set_target_properties(binder_ios PROPERTIES
    OUTPUT_NAME Binder
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/Info.plist.in")
target_compile_options(binder_ios PRIVATE -fobjc-arc)
target_include_directories(binder_ios PRIVATE src)
target_link_libraries(binder_ios PRIVATE binder_app cardpaths carddownload
    "-framework UIKit" "-framework WebKit" "-framework Network" "-framework Foundation")

set(_bundle "$<TARGET_BUNDLE_DIR:binder_ios>")
set(_app_source "${CMAKE_CURRENT_SOURCE_DIR}/../../app")
add_custom_command(TARGET binder_ios POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${_bundle}/frontend"
    COMMAND ${CMAKE_COMMAND} -E copy "${_app_source}/index.html" "${_bundle}/frontend/index.html"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${_app_source}/css" "${_bundle}/frontend/css"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${_app_source}/js" "${_bundle}/frontend/js"
    COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_CURRENT_SOURCE_DIR}/resources" "${_bundle}"
    COMMENT "Copying the frontend and icons into Binder.app")

file(GLOB _bundled_data "${CMAKE_CURRENT_SOURCE_DIR}/../binder/packaging/bundled_data/*")
list(FILTER _bundled_data EXCLUDE REGEX "README\\.md$")
if(_bundled_data)
    add_custom_command(TARGET binder_ios POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_CURRENT_SOURCE_DIR}/../binder/packaging/bundled_data" "${_bundle}/data"
        COMMAND ${CMAKE_COMMAND} -E remove -f "${_bundle}/data/README.md"
        COMMENT "Copying the bundled models into Binder.app")
endif()
