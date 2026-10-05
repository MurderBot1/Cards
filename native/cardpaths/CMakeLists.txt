add_library(cardpaths STATIC src/cardpaths.cpp)
target_include_directories(cardpaths PUBLIC include)

if(BINDER_BUILD_TESTS)
    add_executable(cardpaths_test tests/test_cardpaths.cpp)
    target_link_libraries(cardpaths_test PRIVATE cardpaths cardtest)
    add_test(NAME cardpaths COMMAND cardpaths_test)
endif()
