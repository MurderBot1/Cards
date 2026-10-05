find_package(Threads REQUIRED)

# The API: every endpoint js/api.js expects, as a function that registers
# routes on a cardhttp::Server. A library (not just part of main) so the tests
# can drive it end to end over real HTTP.
add_library(binder_api STATIC src/api.cpp)
target_include_directories(binder_api PUBLIC src)
target_link_libraries(binder_api PUBLIC cardhttp cardstore cardauth cardscan cardlog)

add_executable(binder src/main.cpp)
target_link_libraries(binder PRIVATE binder_api cardpaths cardlog Threads::Threads)

if(BINDER_BUILD_TESTS)
    add_executable(binder_api_test tests/test_api.cpp)
    target_link_libraries(binder_api_test PRIVATE binder_api cardpaths cardtest)
    target_include_directories(binder_api_test PRIVATE ${httplib_SOURCE_DIR})
    target_compile_definitions(binder_api_test PRIVATE BINDER_REPO_APP_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../app")
    add_test(NAME binder_api COMMAND binder_api_test)
    set_tests_properties(binder_api PROPERTIES TIMEOUT 60)
endif()
