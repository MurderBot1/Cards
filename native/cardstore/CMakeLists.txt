binder_use_json()

add_library(cardstore STATIC src/store.cpp)
target_include_directories(cardstore PUBLIC include)
target_link_libraries(cardstore PUBLIC nlohmann_json::nlohmann_json)

if(BINDER_BUILD_TESTS)
    add_executable(cardstore_test tests/test_store.cpp)
    target_link_libraries(cardstore_test PRIVATE cardstore cardtest)
    add_test(NAME cardstore COMMAND cardstore_test)
endif()
