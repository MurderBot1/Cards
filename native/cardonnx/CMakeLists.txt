# ONNX Runtime-backed model source for cardscan: the YOLO card detector, PaddleOCR text pipeline and
# DINOv2 art embedder from cardnet, adapted to cardscan's small backend interfaces.
add_library(cardonnx STATIC src/onnx_models.cpp)
target_include_directories(cardonnx PUBLIC include)
target_link_libraries(cardonnx PUBLIC cardscan cardnet_core)

if(BINDER_BUILD_TESTS)
    add_executable(cardonnx_test tests/test_onnx_models.cpp)
    target_link_libraries(cardonnx_test PRIVATE cardonnx cardtest)
    add_test(NAME cardonnx COMMAND cardonnx_test)
    set_tests_properties(cardonnx PROPERTIES TIMEOUT 120)
endif()
