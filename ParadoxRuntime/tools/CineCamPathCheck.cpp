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
    const Rect V = FitRect(1920.f, 1080.f, 9.f / 16.f);                        // vertical crop of a 1080p frame
    assert(Near(V.W, 607.5f) && Near(V.H, 1080.f) && Near(V.X, (1920.f - 607.5f) * 0.5f) && Near(V.Y, 0.f));
    const Rect Wide = FitRect(1920.f, 1080.f, 2.39f);                           // letterbox: full width
    assert(Near(Wide.W, 1920.f) && Near(Wide.H, 1920.f / 2.39f) && Wide.Y > 0.f);
    const Rect All = FitRect(800.f, 600.f, 0.f);
    assert(Near(All.W, 800.f) && Near(All.H, 600.f));
    assert(Near(FovToMm(MmToFov(50.f)), 50.f) && fabsf(FovToMm(90.f) - 18.f) < 1e-3f);
    for (float T = 0.f; T < 20.f; T += 0.37f) {                                 // shake: bounded, repeatable, off = 0
        const Pose A = ShakeAt(T, 5, 2.f, 1.5f), B = ShakeAt(T, 5, 2.f, 1.5f);
        assert(Near(A[PYaw], B[PYaw]) && fabsf(A[PYaw]) <= kShakes[5].Rot * 2.f + 1e-4f && fabsf(A[PZ]) <= kShakes[5].Pos * 2.f + 1e-4f);
        assert(ShakeAt(T, 0, 1.f, 1.f)[PYaw] == 0.f);
    }
    assert(ShakeAt(0.5f, 1, 1.f, 1.f)[PPitch] != 0.f);
    std::vector<Key> Lin = { K(0.f, 0.f), K(1.f, 100.f), K(2.f, 300.f) };    // interpolation per segment
    Lin[0].Interp = 1;
    assert(Near(PathAt(Lin, 0.5f, false, false)[PX], 50.f));                  // linear: exact midpoint
    Lin[1].Interp = 2;
    assert(Near(PathAt(Lin, 1.9f, false, false)[PX], 100.f));                 // hold: stays on the key...
    assert(Near(PathAt(Lin, 2.f, false, false)[PX], 300.f));                  // ...and lands on the last one

    Key P;                                                                       // shot lines, old and new
    assert(ParseKey("key 1.5 10 20 30 40 50 60 70", P, 7.f) && Near(P.Time, 1.5f) && Near(P.P[PFov], 70.f) && Near(P.P[PFocus], 7.f) && P.Interp == 0);
    assert(ParseKey("key 2 1 2 3 4 5 6 7 12.5 1", P, 7.f) && Near(P.P[PFocus], 12.5f) && P.Interp == 1);
    assert(ParseKey("key 2 1 2 3 4 5 6 7 12.5 9", P, 7.f) && P.Interp == 2); // bad interp clamps
    assert(!ParseKey("map Ramsgate", P, 7.f) && !ParseKey("key 1 2 3", P, 7.f));
    puts("cinecam path ok");
    return 0;
}
