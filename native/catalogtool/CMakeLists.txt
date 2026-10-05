# binder-catalog: downloads card data and builds the catalog + vector index the app reads (the port of
# build_scanner_models.py). Run it once on a machine with a network connection; the files it writes
# (cards.sqlite3, card-vectors.cvi) are portable — copy them next to the app or push them to a device.
add_library(catalogtool_lib STATIC src/tool.cpp)
target_include_directories(catalogtool_lib PUBLIC src)
target_link_libraries(catalogtool_lib PUBLIC cardfetch cardingest cardvectors cardcatalog cardscan)

add_executable(binder-catalog src/main.cpp)
target_link_libraries(binder-catalog PRIVATE catalogtool_lib cardfetch_curl cardpaths)
if(TARGET cardonnx)
    target_link_libraries(binder-catalog PRIVATE cardonnx)
    target_compile_definitions(binder-catalog PRIVATE BINDER_HAVE_ONNX=1)
    binder_copy_onnxruntime_dlls(binder-catalog)
    # same rpath as the app: the bundled ONNX Runtime sits next to the executable
    set_target_properties(binder-catalog PROPERTIES INSTALL_RPATH "$ORIGIN")
endif()

if(BINDER_BUILD_TESTS)
    add_executable(catalogtool_test tests/test_tool.cpp)
    target_link_libraries(catalogtool_test PRIVATE catalogtool_lib binder_opencv cardtest ZLIB::ZLIB)
    add_test(NAME catalogtool COMMAND catalogtool_test)
    set_tests_properties(catalogtool PROPERTIES TIMEOUT 120)
endif()
