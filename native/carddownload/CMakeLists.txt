# First-run download of the prebuilt card catalog and vector index. Only the logic lives here, behind
# cardfetch::Transport, so it's testable without a network; the app plugs in cardfetch_curl.
add_library(carddownload STATIC src/download.cpp)
target_include_directories(carddownload PUBLIC include)
target_link_libraries(carddownload PUBLIC cardfetch)

if(BINDER_BUILD_TESTS)
    add_executable(carddownload_test tests/test_download.cpp)
    target_link_libraries(carddownload_test PRIVATE carddownload cardtest)
    add_test(NAME carddownload COMMAND carddownload_test)
    set_tests_properties(carddownload PROPERTIES TIMEOUT 60)
endif()
