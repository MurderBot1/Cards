add_library(cardtext STATIC src/text.cpp)
target_include_directories(cardtext PUBLIC include)

if(BINDER_BUILD_TESTS)
    add_executable(cardtext_test tests/test_text.cpp)
    target_link_libraries(cardtext_test PRIVATE cardtext cardtest)
    add_test(NAME cardtext COMMAND cardtext_test)
endif()
