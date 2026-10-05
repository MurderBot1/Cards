binder_use_json()
binder_use_opencv()

# Card recognition behind the Engine interface. Built on the smaller modules:
#   cardtext     — Unicode title normalization, difflib port, OCR identifier patterns
#   cardcatalog  — the SQLite catalog
#   cardvec      — the exact inner-product vector index
# The ML backends (YOLO / OCR / embedder) are interfaces here; the ONNX Runtime adapters live in
# cardscan_onnx, so everything in this library is testable without models.
add_library(cardscan STATIC
    src/null_engine.cpp
    src/image.cpp
    src/model_source.cpp
    src/pipeline_engine.cpp
)
target_include_directories(cardscan PUBLIC include)
target_link_libraries(cardscan PUBLIC nlohmann_json::nlohmann_json cardtext cardcatalog cardvec_core PRIVATE binder_opencv)

if(BINDER_BUILD_TESTS)
    add_executable(cardscan_image_test tests/test_image.cpp)
    target_link_libraries(cardscan_image_test PRIVATE cardscan binder_opencv cardtest)
    add_test(NAME cardscan_image COMMAND cardscan_image_test)

    add_executable(cardscan_pipeline_test tests/test_pipeline.cpp)
    target_link_libraries(cardscan_pipeline_test PRIVATE cardscan binder_opencv cardtest)
    add_test(NAME cardscan_pipeline COMMAND cardscan_pipeline_test)
    set_tests_properties(cardscan_pipeline PROPERTIES TIMEOUT 120)
endif()
