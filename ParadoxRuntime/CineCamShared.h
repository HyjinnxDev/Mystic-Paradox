#pragma once
// Cinematic camera state shared by the game thread (dllmain.cpp CineCam: drives the camera through UObjects) and
// the menu (CineCamMenu.cpp: Dear ImGui drawn in the D3D11 Present hook, on the RHI thread). Everything below is
// guarded by Lock. The menu never touches UObjects: it edits Settings and Keys directly and asks for anything that
// needs the engine (camera on/off, modes, HUD, moving the camera) through Cmds, which the game thread runs.

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

namespace Cine {

enum { PX, PY, PZ, PYaw, PPitch, PRoll, PFov, PN };
struct Pose {
    float V[PN] = {};
    float& operator[](int I) { return V[I]; }
    float operator[](int I) const { return V[I]; }
};
struct Key { Pose P; float Time = 0.f; };      // Time: seconds from the start of the path

enum class Mode { Off, Free, Tripod, Path };

struct Settings {
    // Camera
    float Speed = 600.f, Look = 1.f, Smooth = 0.85f, Fov = 70.f, Roll = 0.f, Orbit = 0.f;
    bool Track = false;
    int Aspect = 0;                             // index into kAspects
    bool Thirds = false;                        // rule-of-thirds guide (menu only, never recorded)
    // Lens
    int Dof = 0;                                // 0 off, 1 manual, 2 auto (focus on player)
    float Focus = 5.f, Fstop = 2.8f;
    bool MotionBlurOn = false;
    float MotionBlur = 0.5f;
    // Look (colour grading). Off = the game's own look.
    bool Grade = false;
    int Preset = 0;
    float Exposure = 0.f, Temp = 6500.f, Tint = 0.f, Saturation = 1.f, Contrast = 1.f, Split = 0.f;
    float Vignette = 0.4f, Grain = 0.f, Fringe = 0.f, Bloom = 0.675f;
    // Keyframes
    bool Loop = false, Ease = true, ShowPath = true, HideMenuOnPlay = true;
    float Spacing = 3.f;                        // seconds added after the last key for a new one
};

struct Aspect { const char* Name; float Ratio; };   // Ratio 0 = fill the screen
inline constexpr Aspect kAspects[] = {
    { "Fill screen", 0.f }, { "16:9", 16.f / 9.f }, { "2.39:1 widescreen", 2.39f },
    { "9:16 vertical (TikTok, Reels)", 9.f / 16.f }, { "4:5 portrait (Instagram)", 4.f / 5.f }, { "1:1 square", 1.f },
};

enum class CmdType { ToggleCam, Free, Tripod, Play, Stop, AddKey, UpdateKey, GoToKey, Preview, ToggleHud };
struct Cmd { CmdType T; int I = 0; float F = 0.f; };

struct Point { float X, Y; bool On; };          // a projected path point; On = in front of the camera

struct State {
    std::mutex Lock;
    Settings S;
    std::vector<Key> Keys;
    std::vector<Cmd> Cmds;
    // written by the game thread, read by the menu
    Mode M = Mode::Off;
    float PathT = 0.f;                          // seconds into the path while playing / previewing
    bool HudHidden = false;
    std::string Map;
    std::vector<Point> PathPts, KeyPts;         // screen space, for the path overlay
    // menu state
    std::atomic<bool> MenuOpen{ false };
    std::atomic<bool> MenuReady{ false };       // ImGui up (D3D11); false = hotkeys + CINECAM.ini only
    std::atomic<bool> WantMouse{ false }, WantKeyboard{ false };
    std::atomic<unsigned long long> ToastUntil{ 0 };   // GetTickCount64: "press F10" hint on the first camera start
};
extern State G;

// Path math, shared so the menu can preview without the game thread.
float PathLength(const std::vector<Key>& Keys);  // seconds
Pose PathAt(const std::vector<Key>& Keys, float T, bool Ease, bool Loop);
void EvenSpeed(std::vector<Key>& Keys);         // spread key times by distance, same total length

// CineCamMenu.cpp
void MenuStart();                               // game thread, once: hooks Present (no-op if already done)

}  // namespace Cine
