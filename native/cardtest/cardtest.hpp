// Minimal header-only test helpers shared by the modules' tests — no
// framework dependency, same spirit as cardvec/cardnet's plain executables.
#pragma once

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <random>
#include <string>

namespace cardtest {

inline int& failures() {
    static int n = 0;
    return n;
}

template <class A, class B>
void check_eq(const A& a, const B& b, const char* expr_a, const char* expr_b, const char* file, int line) {
    if (!(a == b)) {
        std::cerr << file << ":" << line << ": CHECK_EQ failed: " << expr_a << " == " << expr_b << "\n  left:  " << a
                  << "\n  right: " << b << "\n";
        ++failures();
    }
}

// Returns the process exit code.
inline int finish(const char* suite) {
    if (failures() == 0) {
        std::cout << "OK: " << suite << " passed\n";
        return 0;
    }
    std::cerr << "FAILED: " << suite << " (" << failures() << " check(s))\n";
    return 1;
}

// Scratch directory removed on destruction.
class TempDir {
public:
    TempDir() {
        std::random_device rd;
        std::mt19937_64 gen(rd());
        path_ = std::filesystem::temp_directory_path() / ("binder-test-" + std::to_string(gen()));
        std::filesystem::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        std::filesystem::remove_all(path_, ec);
    }
    TempDir(const TempDir&) = delete;
    TempDir& operator=(const TempDir&) = delete;
    const std::filesystem::path& path() const { return path_; }

private:
    std::filesystem::path path_;
};

}  // namespace cardtest

#define CHECK(cond)                                                                    \
    do {                                                                               \
        if (!(cond)) {                                                                 \
            std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: " #cond "\n"; \
            ++cardtest::failures();                                                    \
        }                                                                              \
    } while (0)

#define CHECK_EQ(a, b) cardtest::check_eq((a), (b), #a, #b, __FILE__, __LINE__)
