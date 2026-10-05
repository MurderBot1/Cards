binder_use_json()

# The fetching core: a Transport interface, an on-disk cache, a streaming gzipped-JSONL reader. zlib only.
add_library(cardfetch STATIC src/fetch.cpp)
target_include_directories(cardfetch PUBLIC include)
target_link_libraries(cardfetch PUBLIC nlohmann_json::nlohmann_json PRIVATE ZLIB::ZLIB)

# The libcurl-backed Transport.
add_library(cardfetch_curl STATIC src/curl_transport.cpp)
target_include_directories(cardfetch_curl PUBLIC include)
target_link_libraries(cardfetch_curl PUBLIC cardfetch PRIVATE CURL::libcurl)

if(BINDER_BUILD_TESTS)
    add_executable(cardfetch_test tests/test_fetch.cpp)
    target_link_libraries(cardfetch_test PRIVATE cardfetch cardfetch_curl cardhttp cardtest ZLIB::ZLIB)
    add_test(NAME cardfetch COMMAND cardfetch_test)
    set_tests_properties(cardfetch PROPERTIES TIMEOUT 60)
endif()
