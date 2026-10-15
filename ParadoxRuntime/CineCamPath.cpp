// Cinematic camera path math (CineCamShared.h): Catmull-Rom through timed keyframes, and even-speed re-timing.
// No engine or ImGui dependencies, so tools\CineCamPathCheck.cpp can build and check it on its own.

#include "CineCamShared.h"
#include <algorithm>
#include <cmath>

namespace Cine {

float PathLength(const std::vector<Key>& Keys) { return Keys.empty() ? 0.f : Keys.back().Time; }

static float CatmullRom(float P0, float P1, float P2, float P3, float T) {
    return 0.5f * (2.f * P1 + (P2 - P0) * T + (2.f * P0 - 5.f * P1 + 4.f * P2 - P3) * T * T
        + (3.f * P1 - P0 - 3.f * P2 + P3) * T * T * T);
}

Pose PathAt(const std::vector<Key>& Keys, float T, bool Ease, bool Loop) {
    const int N = static_cast<int>(Keys.size());
    if (N == 0) return Pose{};
    const float Start = Keys.front().Time, Len = Keys.back().Time - Start;
    if (N == 1 || Len <= 0.f) return Keys.back().P;
    float U = (T - Start) / Len;
    U = Loop ? U - floorf(U) : (std::clamp)(U, 0.f, 1.f);
    if (Ease && !Loop) U = U * U * (3.f - 2.f * U);
    const float At = Start + U * Len;
    int I = 0;
    while (I < N - 2 && At > Keys[I + 1].Time) ++I;
    const float Span = Keys[I + 1].Time - Keys[I].Time;
    const float F = Span > 0.f ? (std::clamp)((At - Keys[I].Time) / Span, 0.f, 1.f) : 1.f;
    const Pose& P0 = Keys[(std::max)(I - 1, 0)].P, & P1 = Keys[I].P, & P2 = Keys[I + 1].P, & P3 = Keys[(std::min)(I + 2, N - 1)].P;
    Pose R;
    for (int K = 0; K < PN; ++K) R[K] = CatmullRom(P0[K], P1[K], P2[K], P3[K], F);
    return R;
}

// Distance between two keys for even speed: centimetres moved plus 5 cm per degree turned, so a pan in place
// still gets time.
static float Distance(const Pose& A, const Pose& B) {
    const float Dx = A[PX] - B[PX], Dy = A[PY] - B[PY], Dz = A[PZ] - B[PZ];
    const float Turn = fabsf(A[PYaw] - B[PYaw]) + fabsf(A[PPitch] - B[PPitch]) + fabsf(A[PRoll] - B[PRoll]);
    return sqrtf(Dx * Dx + Dy * Dy + Dz * Dz) + 5.f * Turn;
}

void EvenSpeed(std::vector<Key>& Keys) {
    if (Keys.size() < 2) return;
    const float Total = Keys.back().Time - Keys.front().Time;
    std::vector<float> Cum(Keys.size(), 0.f);
    for (size_t I = 1; I < Keys.size(); ++I) Cum[I] = Cum[I - 1] + Distance(Keys[I - 1].P, Keys[I].P);
    if (Cum.back() <= 0.f || Total <= 0.f) return;
    for (size_t I = 1; I < Keys.size(); ++I) Keys[I].Time = Keys.front().Time + Total * Cum[I] / Cum.back();
}

}  // namespace Cine
