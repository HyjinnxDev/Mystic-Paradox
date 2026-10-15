// Self-check for the cinematic camera path math (CineCamPath.cpp). From ParadoxRuntime, in a VS x64 prompt:
//   cl /nologo /EHsc /std:c++20 /I. tools\CineCamPathCheck.cpp CineCamPath.cpp /Fe:%TEMP%\cinepath.exe && %TEMP%\cinepath.exe
#include "CineCamShared.h"
#include <cassert>
#include <cmath>
#include <cstdio>

using namespace Cine;

static Key K(float T, float X, float Yaw = 0.f) { Key R; R.Time = T; R.P[PX] = X; R.P[PYaw] = Yaw; R.P[PFov] = 70.f; return R; }
static bool Near(float A, float B) { return fabsf(A - B) < 1e-3f; }

int main() {
    std::vector<Key> Keys = { K(0.f, 0.f), K(2.f, 100.f), K(3.f, 400.f, 90.f) };
    assert(Near(PathLength(Keys), 3.f));
    for (const Key& Q : Keys) assert(Near(PathAt(Keys, Q.Time, false, false)[PX], Q.P[PX]));   // passes every key on time
    assert(Near(PathAt(Keys, 0.f, true, false)[PX], 0.f) && Near(PathAt(Keys, 3.f, true, false)[PX], 400.f));   // ease keeps the ends
    assert(Near(PathAt(Keys, 9.f, false, false)[PX], 400.f));                  // past the end: holds the last key
    assert(Near(PathAt(Keys, 4.f, false, true)[PX], PathAt(Keys, 1.f, false, true)[PX]));   // loop wraps
    assert(Near(PathAt(Keys, 1.5f, false, false)[PFov], 70.f));                 // untouched channels stay put

    EvenSpeed(Keys);                                                            // 100, then 300 cm + 90 deg x 5 = 750
    assert(Near(Keys.front().Time, 0.f) && Near(Keys.back().Time, 3.f));        // same total length
    assert(Near(Keys[1].Time, 3.f * 100.f / 850.f));

    std::vector<Key> One = { K(5.f, 42.f) };
    assert(Near(PathAt(One, 0.f, true, true)[PX], 42.f));
    assert(Near(PathAt({}, 1.f, false, false)[PX], 0.f));
    puts("cinecam path ok");
    return 0;
}
