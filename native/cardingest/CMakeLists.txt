binder_use_json()
find_package(Threads REQUIRED)

add_library(cardingest STATIC src/ingest.cpp)
target_include_directories(cardingest PUBLIC include)
target_link_libraries(cardingest PUBLIC cardfetch cardcatalog nlohmann_json::nlohmann_json Threads::Threads)

if(BINDER_BUILD_TESTS)
    add_executable(cardingest_test tests/test_ingest.cpp)
    target_link_libraries(cardingest_test PRIVATE cardingest cardtest ZLIB::ZLIB)
    add_test(NAME cardingest COMMAND cardingest_test)
    set_tests_properties(cardingest PROPERTIES TIMEOUT 60)
endif()
