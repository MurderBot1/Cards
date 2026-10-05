binder_use_sqlite()

add_library(cardcatalog STATIC src/catalog.cpp)
target_include_directories(cardcatalog PUBLIC include)
target_link_libraries(cardcatalog PUBLIC cardtext)
target_link_libraries(cardcatalog PRIVATE SQLite::SQLite3)

if(BINDER_BUILD_TESTS)
    add_executable(cardcatalog_test tests/test_catalog.cpp)
    target_link_libraries(cardcatalog_test PRIVATE cardcatalog SQLite::SQLite3 cardtest)
    add_test(NAME cardcatalog COMMAND cardcatalog_test)
    set_tests_properties(cardcatalog PROPERTIES TIMEOUT 60)
endif()
