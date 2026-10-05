add_library(cardlog STATIC src/cardlog.cpp)
target_include_directories(cardlog PUBLIC include)

if(BINDER_BUILD_TESTS)
    add_executable(cardlog_test tests/test_cardlog.cpp)
    target_link_libraries(cardlog_test PRIVATE cardlog cardtest)
    add_test(NAME cardlog COMMAND cardlog_test)
endif()
