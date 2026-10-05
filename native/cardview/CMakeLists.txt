binder_use_webview()
binder_use_json()
find_package(Threads REQUIRED)

add_library(cardview STATIC src/view.cpp)
target_include_directories(cardview PUBLIC include)
target_link_libraries(cardview PUBLIC webview::core_static)

if(BINDER_BUILD_TESTS AND TARGET cardhttp AND CMAKE_SYSTEM_NAME STREQUAL "Linux")
    # Opens a real window, so it needs a display (CI runs it under xvfb); without one it reports "skipped".
    add_executable(cardview_test tests/test_view.cpp)
    target_link_libraries(cardview_test PRIVATE cardview cardhttp cardtest nlohmann_json::nlohmann_json Threads::Threads)
    add_test(NAME cardview COMMAND cardview_test)
    set_tests_properties(cardview PROPERTIES TIMEOUT 90 SKIP_RETURN_CODE 77)
endif()
