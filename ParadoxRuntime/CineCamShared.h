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

enum { PX, PY, PZ, PYaw, PPitch, PRoll, PFov, PFocus, PN };   // PFocus: metres
struct Pose {
    float V[PN] = {};
    float& operator[](int I) { return V[I]; }
    float operator[](int I) const { return V[I]; }
};
struct Key {
    Pose P;
    float Time = 0.f;                           // seconds from the start of the path
    int Interp = 0;                             // kInterps: how the camera gets from this key to the next
};
inline constexpr const char* kInterps[] = { "Smooth", "Linear", "Hold" };

enum class Mode { Off, Free, Tripod, Path, Follow };

struct Settings {
    // Camera
    float Speed = 600.f, Look = 1.f, Smooth = 0.85f, Fov = 70.f, Roll = 0.f, Orbit = 0.f;
    bool Track = false;                         // tripod / path: keep pointing at the target
    int Aspect = 0;                             // index into kAspects
    int PhotoScale = 2;                         // HighResShot multiplier
    // Rig
    int Target = 0;                             // 0 me, 1 nearest behemoth, 2 + I = State::Party[I]
    float AimZ = 60.f;                          // cm above the target's origin (chest, not belt)
    float FrameX = 0.f, FrameY = 0.f;           // where the target sits on screen, -1..1 (left/bottom .. right/top)
    bool FollowLocal = false;                   // follow: offset turns with the target
    int Shake = 0;                              // index into kShakes
    float ShakeAmt = 1.f, ShakeFreq = 1.f;
    // Guides: drawn into the frame (a recording catches them), shown with or without the menu; G / menu toggle.
    bool Guides = false, GuidesHideOnPlay = true;
    bool Thirds = true, GPhi = false, GCenter = false, GDiagonals = false, GSafe = false, GHorizon = false;
    int GCrop = 0;                              // bit I = kCrops[I] crop frame
    int GSocial = 0;                            // 0 off, else kSocial[GSocial - 1] app UI zones inside the 9:16 crop
    float GCropMask = 0.55f, GOpacity = 0.5f;   // dimming outside the crop / line strength
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
    float PlaySpeed = 1.f;
    bool Countdown = true;                      // 3-2-1 on the first keyframe before a path plays
};

struct Aspect { const char* Name; float Ratio; };   // Ratio 0 = fill the screen
inline constexpr Aspect kAspects[] = {
    { "Fill screen", 0.f }, { "16:9", 16.f / 9.f }, { "2.39:1 widescreen", 2.39f },
    { "9:16 vertical (TikTok, Reels)", 9.f / 16.f }, { "4:5 portrait (Instagram)", 4.f / 5.f }, { "1:1 square", 1.f },
};

// Crop frames drawn over the full picture: record 16:9, crop in the editor.
inline constexpr Aspect kCrops[] = {
    { "9:16", 9.f / 16.f }, { "4:5", 4.f / 5.f }, { "1:1", 1.f }, { "2.39:1", 2.39f }, { "16:9", 16.f / 9.f },
};

// Where an app's own buttons and captions do not cover a 9:16 video, as fractions of that frame.
// ponytail: eyeballed from current app layouts; they move every redesign - retune from a screenshot.
struct Social { const char* Name; float L, T, R, B; };
inline constexpr Social kSocial[] = {
    { "TikTok", 0.06f, 0.11f, 0.84f, 0.78f },
    { "Instagram Reels", 0.06f, 0.13f, 0.85f, 0.77f },
    { "YouTube Shorts", 0.06f, 0.12f, 0.82f, 0.75f },
};

// Procedural camera shake: Rot degrees, Pos cm at amount 1, base frequency in Hz.
struct ShakeProfile { const char* Name; float Rot, Pos, Freq; };
inline constexpr ShakeProfile kShakes[] = {
    { "Off", 0.f, 0.f, 0.f }, { "Handheld", 0.8f, 1.5f, 0.6f }, { "Shoulder rig", 0.4f, 0.8f, 0.4f },
    { "Walking", 0.9f, 3.f, 1.8f }, { "Vehicle", 0.5f, 2.f, 6.f }, { "Earthquake", 1.5f, 6.f, 9.f },
};
Pose ShakeAt(float T, int Preset, float Amt, float Freq);   // offset to add to the pose; |each channel| <= profile * Amt

struct Rect { float X, Y, W, H; };
Rect FitRect(float W, float H, float Ratio);    // largest Ratio (w/h) rect centred in W x H; Ratio <= 0 = all of it
float FovToMm(float Fov);                       // horizontal FOV (deg) <-> focal length on a 36 mm wide sensor
float MmToFov(float Mm);

enum class CmdType {
    ToggleCam, Free, Tripod, Play, Stop, AddKey, UpdateKey, GoToKey, Preview, ToggleHud, Follow,
    Photo,                                      // I = resolution multiplier
    PickFocus,                                  // I = screen x, F = screen y
    Dolly,                                      // dolly zoom on / off
};
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
    float CamFov = 70.f, CamRoll = 0.f;         // the camera as it is this frame (readouts, horizon guide)
    std::string Map;
    std::vector<std::string> Party;             // other players' names, for Settings::Target
    std::string TargetName;                     // what the camera is aiming at right now
    bool Dolly = false;                         // dolly zoom holding the target's size
    std::vector<Point> PathPts, KeyPts;         // screen space, for the path overlay
    // menu state
    std::atomic<bool> MenuOpen{ false };
    std::atomic<bool> MenuReady{ false };       // ImGui up (D3D11); false = hotkeys + CINECAM.ini only
    std::atomic<bool> WantMouse{ false }, WantKeyboard{ false };
    std::atomic<bool> GuidesShown{ false };     // game thread: guides on and not hidden by a playing path
    std::atomic<int> Countdown{ 0 };            // game thread: 3, 2, 1 before a path plays, else 0
    std::atomic<bool> PickingFocus{ false };    // menu: the next click in the world sets the focus
    std::atomic<unsigned long long> ToastUntil{ 0 };   // GetTickCount64: "press F10" hint on the first camera start
};
extern State G;

// Path math, shared so the menu can preview without the game thread.
float PathLength(const std::vector<Key>& Keys);  // seconds
Pose PathAt(const std::vector<Key>& Keys, float T, bool Ease, bool Loop);
void EvenSpeed(std::vector<Key>& Keys);         // spread key times by distance, same total length
// Saved shot line "key t x y z yaw pitch roll fov focus interp"; also reads the older 8-number lines (no focus /
// interp: DefFocus, Smooth).
bool ParseKey(const char* Line, Key& K, float DefFocus);

// CineCamMenu.cpp
void MenuStart();                               // game thread, once: hooks Present (no-op if already done)

}  // namespace Cine
