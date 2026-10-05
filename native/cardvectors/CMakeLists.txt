find_package(Threads REQUIRED)

add_library(cardvectors STATIC src/vectors.cpp)
target_include_directories(cardvectors PUBLIC include)
target_link_libraries(cardvectors PUBLIC cardfetch cardcatalog cardscan cardvec_core Threads::Threads)

if(BINDER_BUILD_TESTS)
    add_executable(cardvectors_test tests/test_vectors.cpp)
    target_link_libraries(cardvectors_test PRIVATE cardvectors binder_opencv cardtest)
    add_test(NAME cardvectors COMMAND cardvectors_test)
    set_tests_properties(cardvectors PROPERTIES TIMEOUT 120)
endif()
