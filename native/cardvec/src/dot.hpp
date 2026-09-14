#pragma once
// Dot-product kernel with a SIMD fast path selected at compile time:
// AVX2+FMA on x86_64 (Windows/macOS/Linux desktop builds), NEON on
// arm64 (Android's arm64-v8a, the ABI virtually every device ships),
// and a manually-unrolled scalar fallback everywhere else (x86 32-bit,
// armeabi-v7a, x86_64 without AVX2 enabled at compile time, etc).
//
// No runtime CPU dispatch: the desktop build compiles with -mavx2 -mfma
// (see CMakeLists.txt) so this is decided once, at build time, per target.

#include <cstdint>

#if defined(__AVX2__) && defined(__FMA__) && (defined(__x86_64__) || defined(_M_X64))
    #define CARDVEC_HAVE_AVX2 1
    #include <immintrin.h>
#endif

#if defined(__ARM_NEON) || defined(__ARM_NEON__)
    #define CARDVEC_HAVE_NEON 1
    #include <arm_neon.h>
#endif

namespace cardvec::detail {

inline float dot_scalar(const float* a, const float* b, std::int64_t dim) {
    // Four accumulators so the compiler can pipeline independent FMA
    // chains even without vector intrinsics.
    float s0 = 0.f, s1 = 0.f, s2 = 0.f, s3 = 0.f;
    std::int64_t i = 0;
    for (; i + 4 <= dim; i += 4) {
        s0 += a[i + 0] * b[i + 0];
        s1 += a[i + 1] * b[i + 1];
        s2 += a[i + 2] * b[i + 2];
        s3 += a[i + 3] * b[i + 3];
    }
    float sum = (s0 + s1) + (s2 + s3);
    for (; i < dim; ++i) sum += a[i] * b[i];
    return sum;
}

#if defined(CARDVEC_HAVE_AVX2)
inline float dot_avx2(const float* a, const float* b, std::int64_t dim) {
    __m256 acc0 = _mm256_setzero_ps();
    __m256 acc1 = _mm256_setzero_ps();
    std::int64_t i = 0;
    for (; i + 16 <= dim; i += 16) {
        acc0 = _mm256_fmadd_ps(_mm256_loadu_ps(a + i), _mm256_loadu_ps(b + i), acc0);
        acc1 = _mm256_fmadd_ps(_mm256_loadu_ps(a + i + 8), _mm256_loadu_ps(b + i + 8), acc1);
    }
    for (; i + 8 <= dim; i += 8) {
        acc0 = _mm256_fmadd_ps(_mm256_loadu_ps(a + i), _mm256_loadu_ps(b + i), acc0);
    }
    __m256 acc = _mm256_add_ps(acc0, acc1);
    __m128 lo = _mm256_castps256_ps128(acc);
    __m128 hi = _mm256_extractf128_ps(acc, 1);
    __m128 sum4 = _mm_add_ps(lo, hi);
    sum4 = _mm_hadd_ps(sum4, sum4);
    sum4 = _mm_hadd_ps(sum4, sum4);
    float sum = _mm_cvtss_f32(sum4);
    for (; i < dim; ++i) sum += a[i] * b[i];
    return sum;
}
#endif

#if defined(CARDVEC_HAVE_NEON)
inline float dot_neon(const float* a, const float* b, std::int64_t dim) {
    float32x4_t acc0 = vdupq_n_f32(0.f);
    float32x4_t acc1 = vdupq_n_f32(0.f);
    std::int64_t i = 0;
    for (; i + 8 <= dim; i += 8) {
        acc0 = vmlaq_f32(acc0, vld1q_f32(a + i), vld1q_f32(b + i));
        acc1 = vmlaq_f32(acc1, vld1q_f32(a + i + 4), vld1q_f32(b + i + 4));
    }
    for (; i + 4 <= dim; i += 4) {
        acc0 = vmlaq_f32(acc0, vld1q_f32(a + i), vld1q_f32(b + i));
    }
    float32x4_t acc = vaddq_f32(acc0, acc1);
    float sum = vgetq_lane_f32(acc, 0) + vgetq_lane_f32(acc, 1) +
                vgetq_lane_f32(acc, 2) + vgetq_lane_f32(acc, 3);
    for (; i < dim; ++i) sum += a[i] * b[i];
    return sum;
}
#endif

inline float dot(const float* a, const float* b, std::int64_t dim) {
#if defined(CARDVEC_HAVE_AVX2)
    return dot_avx2(a, b, dim);
#elif defined(CARDVEC_HAVE_NEON)
    return dot_neon(a, b, dim);
#else
    return dot_scalar(a, b, dim);
#endif
}

} // namespace cardvec::detail
