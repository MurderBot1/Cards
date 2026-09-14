// Smoke test for OrtSession against a real ONNX Runtime build: loads a
// tiny hand-built model (input (1,4) -> MatMul(W) -> Add(B) -> (1,3))
// and checks the output against the known matmul+bias result, to
// validate the session-loading/tensor-binding/output-extraction
// plumbing without needing any of Binder's actual trained models.
#include "cardnet/ort_session.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <stdexcept>

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: %s <path to tiny_test.onnx>\n", argv[0]);
        return 2;
    }
    int failures = 0;
    auto check = [&](bool cond, const char* msg) {
        if (!cond) {
            std::fprintf(stderr, "FAIL: %s\n", msg);
            ++failures;
        }
    };

    cardnet::OrtSession session(argv[1]);
    check(session.num_outputs() == 1, "model has exactly one output");

    float input[4] = {1.f, 2.f, 3.f, 4.f};
    // W = [[0,1,2],[3,4,5],[6,7,8],[9,10,11]], B = [1,2,3]
    // expected = input @ W + B
    float W[4][3] = {{0, 1, 2}, {3, 4, 5}, {6, 7, 8}, {9, 10, 11}};
    float B[3] = {1.f, 2.f, 3.f};
    float expected[3] = {0, 0, 0};
    for (int j = 0; j < 3; ++j) {
        float s = B[j];
        for (int i = 0; i < 4; ++i) s += input[i] * W[i][j];
        expected[j] = s;
    }

    auto outputs = session.run(input, {1, 4});
    check(outputs.size() == 1, "run() returns exactly one output tensor");
    if (outputs.size() == 1) {
        check(outputs[0].shape.size() == 2 && outputs[0].shape[0] == 1 && outputs[0].shape[1] == 3,
              "output shape is (1, 3)");
        check(outputs[0].data.size() == 3, "output data has 3 elements");
        for (int j = 0; j < 3 && j < static_cast<int>(outputs[0].data.size()); ++j) {
            char msg[64];
            std::snprintf(msg, sizeof(msg), "output[%d] matches expected matmul+bias", j);
            check(std::fabs(outputs[0].data[j] - expected[j]) < 1e-3f, msg);
        }
        std::printf("got: %.3f %.3f %.3f | expected: %.3f %.3f %.3f\n", outputs[0].data[0], outputs[0].data[1],
                    outputs[0].data[2], expected[0], expected[1], expected[2]);
    }

    bool threw = false;
    try {
        cardnet::OrtSession missing("this_file_does_not_exist.onnx");
    } catch (const std::runtime_error&) {
        threw = true;
    }
    check(threw, "loading a missing model file throws std::runtime_error");

    if (failures == 0) {
        std::printf("OK: OrtSession smoke test passed\n");
        return 0;
    }
    std::fprintf(stderr, "%d OrtSession smoke test failure(s)\n", failures);
    return 1;
}
