find_package(Threads REQUIRED)

# The API: every endpoint js/api.js expects, as a function that registers
# routes on a cardhttp::Server. A library (not just part of main) so the tests
# can drive it end to end over real HTTP.
add_library(binder_api STATIC src/api.cpp)
target_include_directories(binder_api PUBLIC src)
target_link_libraries(binder_api PUBLIC cardhttp cardstore cardauth cardscan cardlog)

add_executable(binder src/main.cpp)
target_link_libraries(binder PRIVATE binder_api cardpaths cardlog Threads::Threads)
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
if(TARGET cardonnx)
    target_link_libraries(binder PRIVATE cardonnx)
    target_compile_definitions(binder PRIVATE BINDER_HAVE_ONNX=1)
endif()

if(BINDER_BUILD_TESTS)
    add_executable(binder_api_test tests/test_api.cpp)
    target_link_libraries(binder_api_test PRIVATE binder_api cardpaths cardtest)
    target_include_directories(binder_api_test PRIVATE ${httplib_SOURCE_DIR})
    target_compile_definitions(binder_api_test PRIVATE BINDER_REPO_APP_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../app")
    add_test(NAME binder_api COMMAND binder_api_test)
    set_tests_properties(binder_api PROPERTIES TIMEOUT 60)
endif()
