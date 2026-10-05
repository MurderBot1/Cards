binder_use_httplib()
find_package(Threads REQUIRED)

add_library(cardhttp STATIC src/server.cpp)
target_include_directories(cardhttp PUBLIC include)
target_link_libraries(cardhttp PUBLIC Threads::Threads PRIVATE httplib::httplib)

if(BINDER_BUILD_TESTS)
    add_executable(cardhttp_test tests/test_server.cpp)
    target_link_libraries(cardhttp_test PRIVATE cardhttp httplib::httplib cardtest)
    add_test(NAME cardhttp COMMAND cardhttp_test)
    set_tests_properties(cardhttp PROPERTIES TIMEOUT 60)
endif()
