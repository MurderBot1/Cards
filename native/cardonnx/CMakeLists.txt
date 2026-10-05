# ONNX Runtime-backed model source for cardscan: the YOLO card detector, PaddleOCR text pipeline and
# DINOv2 art embedder from cardnet, adapted to cardscan's small backend interfaces.
# Windows looks for a DLL next to the executable first, then in System32 — which ships its own, older onnxruntime.dll
# (Windows ML) — and only then on PATH. So every executable that uses ONNX Runtime needs ours beside it (an installed app
# gets it from the install rules; this is for the build tree and the tests). Call this from the directory that defines `target`.
function(binder_copy_onnxruntime_dlls target)
    if(WIN32 AND ONNXRUNTIME_ROOT_DIR)
        file(GLOB _binder_ort_dlls "${ONNXRUNTIME_ROOT_DIR}/lib/*.dll")
        add_custom_command(TARGET ${target} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different ${_binder_ort_dlls} "$<TARGET_FILE_DIR:${target}>")
    endif()
endfunction()

add_library(cardonnx STATIC src/onnx_models.cpp)
target_include_directories(cardonnx PUBLIC include)
target_link_libraries(cardonnx PUBLIC cardscan cardnet_core)

if(BINDER_BUILD_TESTS)
    add_executable(cardonnx_test tests/test_onnx_models.cpp)
    target_link_libraries(cardonnx_test PRIVATE cardonnx cardtest)
    binder_copy_onnxruntime_dlls(cardonnx_test)
    add_test(NAME cardonnx COMMAND cardonnx_test)
    set_tests_properties(cardonnx PROPERTIES TIMEOUT 120)
endif()
