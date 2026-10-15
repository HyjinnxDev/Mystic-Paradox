/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Cinematic camera menu (F10): Dear ImGui (imgui/, MIT) drawn on top of the game's frame from an
// IDXGISwapChain::Present hook. The game's window procedure is subclassed so the menu gets the mouse and keyboard;
// clicks and typing the menu uses never reach the game. Only D3D11 is handled: on D3D12 the swap chain has no
// D3D11 device, the menu stays off (logged) and the camera keeps its hotkeys and CINECAM.ini.
// Runs on the RHI thread (Present) and the game thread (window messages); ImGui itself is guarded by s_ImLock and
// the camera state by Cine::G.Lock (see CineCamShared.h). Never touches UObjects. Log tag [CineCam].
// ponytail: D3D11 only, one swap chain (the first one presented), no gamepad navigation.

#define _CRT_SECURE_NO_WARNINGS                     // fopen/sscanf on our own fixed-format shot files
#include "RuntimeShared.h"
#include "CineCamShared.h"
#include <d3d11.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include "MinHook/MinHook.h"
#include "imgui/imgui.h"
#include "imgui/imgui_impl_dx11.h"
#include "imgui/imgui_impl_win32.h"

#pragma comment(lib, "d3d11.lib")

extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

namespace Cine {

State G;

// ---------------------------------------------------------------- looks

struct Look { const char* Name; float Exposure, Temp, Tint, Saturation, Contrast, Split, Vignette, Grain, Fringe, Bloom; };
static constexpr Look kLooks[] = {
    { "Natural",        0.f,   6500.f,  0.f,   1.f,  1.f,  0.f,  0.4f,  0.f,   0.f, 0.675f },
    { "Cinematic",     -0.2f,  6300.f,  0.f,   0.9f, 1.12f, 0.3f, 0.55f, 0.12f, 0.6f, 0.9f },
    { "Teal & orange",  0.f,   6500.f,  0.f,   1.1f, 1.1f,  1.f,  0.5f,  0.05f, 0.4f, 0.8f },
    { "Golden hour",    0.2f,  4200.f,  0.05f, 1.15f, 1.05f, 0.2f, 0.45f, 0.05f, 0.f, 1.3f },
    { "Cold",          -0.1f,  9500.f, -0.05f, 0.85f, 1.1f,  0.f,  0.5f,  0.05f, 0.f, 0.6f },
    { "Noir",          -0.1f,  6500.f,  0.f,   0.f,  1.35f, 0.f,  0.75f, 0.35f, 0.f, 0.5f },
    { "Vintage film",   0.1f,  5200.f,  0.1f,  0.7f, 0.9f,  0.2f, 0.7f,  0.5f,  1.5f, 1.1f },
    { "Vibrant",        0.1f,  6500.f,  0.f,   1.4f, 1.15f, 0.f,  0.3f,  0.f,   0.f, 0.9f },
    { "Dreamy",         0.3f,  6000.f,  0.1f,  0.9f, 0.85f, 0.1f, 0.4f,  0.1f,  1.f, 3.f },
};
constexpr int kCustom = static_cast<int>(sizeof(kLooks) / sizeof(kLooks[0]));   // preset index "Custom"

static void ApplyLook(Settings& S, int I) {
    const Look& L = kLooks[I];
    S.Exposure = L.Exposure; S.Temp = L.Temp; S.Tint = L.Tint; S.Saturation = L.Saturation; S.Contrast = L.Contrast;
    S.Split = L.Split; S.Vignette = L.Vignette; S.Grain = L.Grain; S.Fringe = L.Fringe; S.Bloom = L.Bloom;
    S.Preset = I;
    S.Grade = true;
}

// ---------------------------------------------------------------- saved shots (CINECAM_shots\<name>.txt beside the exe)

static std::wstring ShotDir() {
    wchar_t Exe[MAX_PATH]{};
    GetModuleFileNameW(nullptr, Exe, MAX_PATH);
    std::wstring P(Exe);
    return P.substr(0, P.find_last_of(L"\\/") + 1) + L"CINECAM_shots\\";
}

static std::wstring Widen(const std::string& S) { return std::wstring(S.begin(), S.end()); }   // names are ASCII

struct Shot { std::string Name, Map; };
static std::vector<Shot> s_Shots;

static void RefreshShots() {
    s_Shots.clear();
    WIN32_FIND_DATAW F;
    HANDLE H = FindFirstFileW((ShotDir() + L"*.txt").c_str(), &F);
    if (H == INVALID_HANDLE_VALUE) return;
    do {
        std::wstring N = F.cFileName;
        Shot S{ std::string(N.begin(), N.end() - 4), "" };
        if (FILE* Fp = _wfopen((ShotDir() + N).c_str(), L"r")) {
            char Map[128]{};
            if (fscanf(Fp, "map %127s", Map) == 1) S.Map = Map;
            fclose(Fp);
        }
        s_Shots.push_back(S);
    } while (FindNextFileW(H, &F));
    FindClose(H);
    std::sort(s_Shots.begin(), s_Shots.end(), [](const Shot& A, const Shot& B) { return A.Name < B.Name; });
}

static bool SaveShot(const std::string& Name) {
    CreateDirectoryW(ShotDir().c_str(), nullptr);
    FILE* Fp = _wfopen((ShotDir() + Widen(Name) + L".txt").c_str(), L"w");
    if (!Fp) return false;
    fprintf(Fp, "map %s\n", G.Map.empty() ? "unknown" : G.Map.c_str());
    for (const Key& K : G.Keys) {
        fprintf(Fp, "key %.4f", K.Time);
        for (int I = 0; I < PN; ++I) fprintf(Fp, " %.4f", K.P[I]);
        fprintf(Fp, "\n");
    }
    fclose(Fp);
    return true;
}

static bool LoadShot(const std::string& Name) {
    FILE* Fp = _wfopen((ShotDir() + Widen(Name) + L".txt").c_str(), L"r");
    if (!Fp) return false;
    std::vector<Key> Keys;
    char Line[512];
    while (fgets(Line, sizeof(Line), Fp)) {
        Key K;
        if (sscanf(Line, "key %f %f %f %f %f %f %f %f", &K.Time, &K.P[0], &K.P[1], &K.P[2], &K.P[3], &K.P[4], &K.P[5], &K.P[6]) == 8)
            Keys.push_back(K);
    }
    fclose(Fp);
    if (Keys.empty()) return false;
    G.Keys = Keys;
    return true;
}

// ---------------------------------------------------------------- menu

static void Tip(const char* Text) {
    if (ImGui::IsItemHovered(ImGuiHoveredFlags_DelayShort)) ImGui::SetTooltip("%s", Text);
}

static void Push(CmdType T, int I = 0, float F = 0.f) { G.Cmds.push_back(Cmd{ T, I, F }); }

static bool Slider(const char* Label, float* V, float Lo, float Hi, const char* Fmt, const char* Help, bool Log = false) {
    const bool Changed = ImGui::SliderFloat(Label, V, Lo, Hi, Fmt, Log ? ImGuiSliderFlags_Logarithmic : 0);
    if (Help) Tip(Help);
    return Changed;
}

static void SectionTitle(const char* Text) {
    ImGui::Spacing();
    ImGui::TextColored(ImVec4(0.95f, 0.66f, 0.26f, 1.f), "%s", Text);
    ImGui::Separator();
}

static void CameraTab(Settings& S) {
    SectionTitle("Movement");
    Slider("Move speed", &S.Speed, 25.f, 5000.f, "%.0f cm/s", "How fast WASD flies. Shift = 4x, Alt = 1/4.", true);
    Slider("Mouse look", &S.Look, 0.05f, 10.f, "%.2f", "Mouse sensitivity while looking around.", true);
    Slider("Smoothing", &S.Smooth, 0.f, 0.98f, "%.2f", "0 = camera follows instantly. Higher = slow, floaty, drone-like moves.");
    SectionTitle("Framing");
    Slider("Field of view", &S.Fov, 5.f, 120.f, "%.0f\xC2\xB0", "Zoom. Low = telephoto close-up, high = wide angle. Mouse wheel changes it too.");
    Slider("Roll", &S.Roll, -90.f, 90.f, "%.0f\xC2\xB0", "Tilts the horizon (dutch angle). Z / X change it too.");
    if (ImGui::BeginCombo("Frame shape", kAspects[S.Aspect].Name)) {
        for (int I = 0; I < static_cast<int>(std::size(kAspects)); ++I)
            if (ImGui::Selectable(kAspects[I].Name, I == S.Aspect)) S.Aspect = I;
        ImGui::EndCombo();
    }
    Tip("Black bars around the picture. 9:16 frames a vertical TikTok/Reels shot so you only need to crop.");
    ImGui::Checkbox("Rule-of-thirds guide", &S.Thirds);
    Tip("Grid lines to help line up shots. Only shown while this menu is open, so they never end up in a recording.");
    if (ImGui::Button("Reset zoom and roll")) { S.Fov = 70.f; S.Roll = 0.f; }
    SectionTitle("Tracking");
    ImGui::Checkbox("Aim at my character", &S.Track);
    Tip("In tripod mode and while a path plays, the camera keeps pointing at you.");
    Slider("Orbit speed", &S.Orbit, -90.f, 90.f, "%.0f\xC2\xB0/s", "Tripod + aim: circles around your character. Negative goes the other way.");
}

static void LensTab(Settings& S) {
    SectionTitle("Depth of field");
    static const char* Dof[] = { "Off", "Manual focus", "Auto focus on my character" };
    ImGui::Combo("Focus", &S.Dof, Dof, 3);
    Tip("Blurs what is out of focus, like a real camera lens.");
    ImGui::BeginDisabled(S.Dof == 0);
    ImGui::BeginDisabled(S.Dof != 1);
    Slider("Focus distance", &S.Focus, 0.5f, 200.f, "%.1f m", "How far away the sharp area is.", true);
    ImGui::EndDisabled();
    Slider("Aperture", &S.Fstop, 0.7f, 32.f, "f/%.1f", "Lower = stronger background blur. f/1.4 is very blurry, f/16 almost none.", true);
    ImGui::EndDisabled();
    SectionTitle("Motion blur");
    ImGui::Checkbox("Override motion blur", &S.MotionBlurOn);
    ImGui::BeginDisabled(!S.MotionBlurOn);
    Slider("Amount", &S.MotionBlur, 0.f, 1.f, "%.2f", "0 = crisp frames, 1 = heavy streaks on fast moves.");
    ImGui::EndDisabled();
}

static void LookTab(Settings& S) {
    ImGui::Checkbox("Colour grading", &S.Grade);
    Tip("Off = the game's own colours.");
    const char* Current = S.Preset < kCustom ? kLooks[S.Preset].Name : "Custom";
    if (ImGui::BeginCombo("Preset", Current)) {
        for (int I = 0; I < kCustom; ++I)
            if (ImGui::Selectable(kLooks[I].Name, I == S.Preset)) ApplyLook(S, I);
        ImGui::EndCombo();
    }
    ImGui::BeginDisabled(!S.Grade);
    bool Changed = false;
    SectionTitle("Light and colour");
    Changed |= Slider("Exposure", &S.Exposure, -3.f, 3.f, "%+.2f EV", "Brighter or darker.");
    Changed |= Slider("Temperature", &S.Temp, 2000.f, 12000.f, "%.0f K", "Lower = warmer (orange), higher = cooler (blue). 6500 = neutral.");
    Changed |= Slider("Tint", &S.Tint, -1.f, 1.f, "%+.2f", "Green (-) or magenta (+).");
    Changed |= Slider("Saturation", &S.Saturation, 0.f, 2.f, "%.2f", "0 = black and white.");
    Changed |= Slider("Contrast", &S.Contrast, 0.5f, 1.6f, "%.2f", nullptr);
    Changed |= Slider("Teal & orange", &S.Split, 0.f, 1.f, "%.2f", "Blockbuster split toning: teal shadows, warm highlights.");
    SectionTitle("Lens effects");
    Changed |= Slider("Vignette", &S.Vignette, 0.f, 1.f, "%.2f", "Darker corners.");
    Changed |= Slider("Film grain", &S.Grain, 0.f, 1.f, "%.2f", nullptr);
    Changed |= Slider("Chromatic aberration", &S.Fringe, 0.f, 5.f, "%.2f", "Colour fringing at the edges, like a cheap lens.");
    Changed |= Slider("Bloom", &S.Bloom, 0.f, 4.f, "%.2f", "Glow around bright lights.");
    ImGui::EndDisabled();
    if (Changed) S.Preset = kCustom;
    if (ImGui::Button("Reset to natural")) ApplyLook(S, 0);
}

static void KeyframesTab(Settings& S) {
    const bool CamOn = G.M != Mode::Off, Playing = G.M == Mode::Path;
    ImGui::BeginDisabled(!CamOn);
    if (ImGui::Button("+ Add keyframe  (K)", ImVec2(180, 0))) Push(CmdType::AddKey);
    Tip("Adds the camera's current position, angle, zoom and roll.");
    ImGui::SameLine();
    ImGui::BeginDisabled(G.Keys.size() < 2 && !Playing);
    if (ImGui::Button(Playing ? "Stop" : "Play  (L)", ImVec2(100, 0))) Push(Playing ? CmdType::Stop : CmdType::Play);
    Tip("Plays the path. You can play your character while it runs.");
    ImGui::EndDisabled();
    ImGui::EndDisabled();
    if (!CamOn) ImGui::TextDisabled("Start the camera (F8) to add keyframes.");

    const float Len = PathLength(G.Keys);
    if (G.Keys.size() >= 2) {
        float T = G.PathT;
        ImGui::SetNextItemWidth(-1);
        if (ImGui::SliderFloat("##scrub", &T, 0.f, Len, "Preview  %.1f s") && CamOn) Push(CmdType::Preview, 0, T);
        Tip("Drag to move the camera along the path.");
    }

    SectionTitle("Timing");
    ImGui::Checkbox("Ease in and out", &S.Ease); Tip("Starts and stops gently instead of at full speed.");
    ImGui::SameLine(); ImGui::Checkbox("Loop", &S.Loop);
    ImGui::Checkbox("Show path", &S.ShowPath); Tip("Draws the path and numbered keyframes in the world while the menu is open.");
    ImGui::SameLine(); ImGui::Checkbox("Hide menu while playing", &S.HideMenuOnPlay);
    Slider("New keyframe gap", &S.Spacing, 0.5f, 20.f, "%.1f s", "Time between the last keyframe and a newly added one.");
    if (G.Keys.size() >= 2) {
        float Total = Len;
        if (ImGui::DragFloat("Total length", &Total, 0.1f, 0.5f, 600.f, "%.1f s") && Len > 0.f)
            for (Key& K : G.Keys) K.Time *= Total / Len;
        Tip("Drag to stretch or squeeze the whole path.");
        if (ImGui::Button("Even out speed")) EvenSpeed(G.Keys);
        Tip("Re-times the keyframes so the camera moves at a steady speed. Total length stays the same.");
        ImGui::SameLine();
    }
    if (!G.Keys.empty() && ImGui::Button("Clear all")) ImGui::OpenPopup("Clear keyframes?");
    if (ImGui::BeginPopupModal("Clear keyframes?", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
        ImGui::Text("Delete all %d keyframes?", static_cast<int>(G.Keys.size()));
        if (ImGui::Button("Delete", ImVec2(100, 0))) { G.Keys.clear(); ImGui::CloseCurrentPopup(); }
        ImGui::SameLine();
        if (ImGui::Button("Cancel", ImVec2(100, 0))) ImGui::CloseCurrentPopup();
        ImGui::EndPopup();
    }

    SectionTitle("Keyframes");
    if (G.Keys.empty()) ImGui::TextDisabled("None yet. Fly to a spot and press K.");
    int Remove = -1, Up = -1;
    bool Resort = false;
    if (!G.Keys.empty() && ImGui::BeginTable("keys", 3, ImGuiTableFlags_RowBg | ImGuiTableFlags_SizingFixedFit)) {
        ImGui::TableSetupColumn("#");
        ImGui::TableSetupColumn("Time");
        ImGui::TableSetupColumn("", ImGuiTableColumnFlags_WidthStretch);
        for (int I = 0; I < static_cast<int>(G.Keys.size()); ++I) {
            ImGui::PushID(I);
            ImGui::TableNextRow();
            ImGui::TableNextColumn(); ImGui::Text("%d", I + 1);
            ImGui::TableNextColumn();
            ImGui::SetNextItemWidth(70);
            ImGui::DragFloat("##t", &G.Keys[I].Time, 0.05f, 0.f, 600.f, "%.1f s");
            if (ImGui::IsItemDeactivatedAfterEdit()) Resort = true;
            ImGui::TableNextColumn();
            ImGui::BeginDisabled(!CamOn);
            if (ImGui::SmallButton("Go to")) Push(CmdType::GoToKey, I);
            Tip("Moves the camera to this keyframe.");
            ImGui::SameLine();
            if (ImGui::SmallButton("Update")) Push(CmdType::UpdateKey, I);
            Tip("Replaces this keyframe with the camera's current view.");
            ImGui::EndDisabled();
            ImGui::SameLine();
            ImGui::BeginDisabled(I == 0);
            if (ImGui::ArrowButton("##up", ImGuiDir_Up)) Up = I;
            ImGui::EndDisabled();
            ImGui::SameLine();
            if (ImGui::SmallButton("Delete")) Remove = I;
            ImGui::PopID();
        }
        ImGui::EndTable();
    }
    if (Up > 0) std::swap(G.Keys[Up].P, G.Keys[Up - 1].P);   // swap views, keep the timing
    if (Remove >= 0) G.Keys.erase(G.Keys.begin() + Remove);
    if (Resort) std::stable_sort(G.Keys.begin(), G.Keys.end(), [](const Key& A, const Key& B) { return A.Time < B.Time; });

    SectionTitle("Saved shots");
    static char Name[48] = "shot1";
    static std::string Status;
    static bool Listed = false;
    if (!Listed) { Listed = true; RefreshShots(); }
    ImGui::SetNextItemWidth(180);
    ImGui::InputText("##name", Name, sizeof(Name), ImGuiInputTextFlags_CallbackCharFilter,
        [](ImGuiInputTextCallbackData* D) { const ImWchar C = D->EventChar; return C < 128 && (isalnum(C) || C == '_' || C == '-') ? 0 : 1; });
    ImGui::SameLine();
    ImGui::BeginDisabled(G.Keys.empty() || !Name[0]);
    if (ImGui::Button("Save")) { Status = SaveShot(Name) ? std::string("Saved ") + Name : "Could not save"; RefreshShots(); }
    ImGui::EndDisabled();
    Tip("Saves the keyframes to CINECAM_shots beside the game, to replay or retake later.");
    if (!Status.empty()) ImGui::TextDisabled("%s", Status.c_str());
    for (const Shot& Sh : s_Shots) {
        ImGui::PushID(Sh.Name.c_str());
        if (ImGui::SmallButton("Load")) { Status = LoadShot(Sh.Name) ? "Loaded " + Sh.Name : "Could not load " + Sh.Name; snprintf(Name, sizeof(Name), "%s", Sh.Name.c_str()); }
        ImGui::SameLine();
        if (ImGui::SmallButton("Delete")) { DeleteFileW((ShotDir() + Widen(Sh.Name) + L".txt").c_str()); RefreshShots(); ImGui::PopID(); break; }
        ImGui::SameLine();
        if (Sh.Map != G.Map && !G.Map.empty()) ImGui::TextColored(ImVec4(1.f, 0.6f, 0.3f, 1.f), "%s  (%s)", Sh.Name.c_str(), Sh.Map.c_str());
        else ImGui::Text("%s", Sh.Name.c_str());
        ImGui::PopID();
    }
}

static void KeysTab() {
    static const char* Rows[][2] = {
        { "F8", "Camera on / off (from tripod or path: back to free camera)" },
        { "F9", "Hide / show the HUD" },
        { "F10", "This menu" },
        { "Right mouse (hold)", "Look around while the menu is open" },
        { "W A S D", "Fly" }, { "E / Space", "Up" }, { "Q / Ctrl", "Down" },
        { "Shift / Alt", "Faster / slower" }, { "Mouse wheel", "Zoom" }, { "Z / X", "Roll" },
        { "R", "Reset zoom and roll" }, { "T", "Tripod: camera stays, you play" },
        { "Y", "Aim at my character on / off" }, { "K", "Add keyframe" }, { "J", "Remove last keyframe" },
        { "L", "Play the path" },
    };
    ImGui::TextWrapped("In the free camera the game ignores your keys, so nothing opens by accident. "
        "Tripod and path playback hand the controls back so you can act while the camera films.");
    ImGui::Spacing();
    if (ImGui::BeginTable("hotkeys", 2, ImGuiTableFlags_RowBg | ImGuiTableFlags_SizingFixedFit)) {
        for (auto& R : Rows) {
            ImGui::TableNextRow();
            ImGui::TableNextColumn(); ImGui::TextColored(ImVec4(0.95f, 0.66f, 0.26f, 1.f), "%s", R[0]);
            ImGui::TableNextColumn(); ImGui::TextUnformatted(R[1]);
        }
        ImGui::EndTable();
    }
}

static void DrawMenu() {
    Settings& S = G.S;
    ImGui::SetNextWindowPos(ImVec2(40, 80), ImGuiCond_FirstUseEver);
    ImGui::SetNextWindowSize(ImVec2(470, 660), ImGuiCond_FirstUseEver);
    if (!ImGui::Begin("Cinematic Camera", nullptr, ImGuiWindowFlags_NoCollapse)) { ImGui::End(); return; }

    static const char* ModeNames[] = { "Off", "Free camera", "Tripod (you play)", "Playing path (you play)" };
    ImGui::Text("Camera:"); ImGui::SameLine();
    ImGui::TextColored(G.M == Mode::Off ? ImVec4(0.6f, 0.6f, 0.6f, 1.f) : ImVec4(0.45f, 0.85f, 0.45f, 1.f), "%s", ModeNames[static_cast<int>(G.M)]);
    if (ImGui::Button(G.M == Mode::Off ? "Start camera  (F8)" : "Stop camera  (F8)", ImVec2(170, 0))) Push(CmdType::ToggleCam);
    ImGui::SameLine();
    ImGui::BeginDisabled(G.M == Mode::Off);
    if (ImGui::RadioButton("Free", G.M == Mode::Free)) Push(CmdType::Free);
    Tip("Fly the camera. The game ignores your keys.");
    ImGui::SameLine();
    if (ImGui::RadioButton("Tripod", G.M == Mode::Tripod)) Push(CmdType::Tripod);
    Tip("Camera stays where it is and you play your character.");
    ImGui::EndDisabled();
    bool Hud = G.HudHidden;
    if (ImGui::Checkbox("Hide HUD  (F9)", &Hud)) Push(CmdType::ToggleHud);
    ImGui::SameLine();
    ImGui::TextDisabled("Hold right mouse to look");
    ImGui::Spacing();

    if (ImGui::BeginTabBar("tabs")) {
        if (ImGui::BeginTabItem("Camera")) { CameraTab(S); ImGui::EndTabItem(); }
        if (ImGui::BeginTabItem("Lens")) { LensTab(S); ImGui::EndTabItem(); }
        if (ImGui::BeginTabItem("Look")) { LookTab(S); ImGui::EndTabItem(); }
        if (ImGui::BeginTabItem("Keyframes")) { KeyframesTab(S); ImGui::EndTabItem(); }
        if (ImGui::BeginTabItem("Keys")) { KeysTab(); ImGui::EndTabItem(); }
        ImGui::EndTabBar();
    }
    ImGui::End();
}

// Path line, numbered keyframes and the thirds guide, under the menu.
static void DrawOverlay() {
    ImDrawList* D = ImGui::GetBackgroundDrawList();
    const ImVec2 Size = ImGui::GetIO().DisplaySize;
    if (G.S.Thirds) {
        float W = Size.x, H = Size.y;
        const float R = kAspects[G.S.Aspect].Ratio;
        if (R > 0.f) { if (W / H > R) W = H * R; else H = W / R; }
        const float X = (Size.x - W) * 0.5f, Y = (Size.y - H) * 0.5f;
        const ImU32 C = IM_COL32(255, 255, 255, 90);
        for (int I = 1; I < 3; ++I) {
            D->AddLine(ImVec2(X + W * I / 3.f, Y), ImVec2(X + W * I / 3.f, Y + H), C);
            D->AddLine(ImVec2(X, Y + H * I / 3.f), ImVec2(X + W, Y + H * I / 3.f), C);
        }
    }
    if (!G.S.ShowPath || G.M == Mode::Path) return;
    for (size_t I = 1; I < G.PathPts.size(); ++I) {
        const Point& A = G.PathPts[I - 1], & B = G.PathPts[I];
        if (A.On && B.On) D->AddLine(ImVec2(A.X, A.Y), ImVec2(B.X, B.Y), IM_COL32(242, 168, 66, 220), 2.5f);
    }
    for (size_t I = 0; I < G.KeyPts.size(); ++I) {
        const Point& P = G.KeyPts[I];
        if (!P.On) continue;
        D->AddCircleFilled(ImVec2(P.X, P.Y), 11.f, IM_COL32(20, 20, 20, 220));
        D->AddCircle(ImVec2(P.X, P.Y), 11.f, IM_COL32(242, 168, 66, 255), 0, 2.f);
        char N[8];
        snprintf(N, sizeof(N), "%d", static_cast<int>(I + 1));
        const ImVec2 Ts = ImGui::CalcTextSize(N);
        D->AddText(ImVec2(P.X - Ts.x * 0.5f, P.Y - Ts.y * 0.5f), IM_COL32(255, 255, 255, 255), N);
    }
}

static void ApplyStyle() {
    ImGuiStyle& St = ImGui::GetStyle();
    ImGui::StyleColorsDark();
    St.WindowRounding = 8.f; St.FrameRounding = 5.f; St.GrabRounding = 5.f; St.TabRounding = 5.f; St.PopupRounding = 6.f;
    St.WindowPadding = ImVec2(14, 12); St.FramePadding = ImVec2(8, 5); St.ItemSpacing = ImVec2(8, 7);
    St.WindowBorderSize = 0.f; St.GrabMinSize = 12.f;
    ImVec4* C = St.Colors;
    const ImVec4 Accent(0.95f, 0.62f, 0.22f, 1.f), AccentDim(0.70f, 0.42f, 0.12f, 1.f);
    C[ImGuiCol_WindowBg] = ImVec4(0.07f, 0.07f, 0.08f, 0.94f);
    C[ImGuiCol_TitleBg] = C[ImGuiCol_TitleBgActive] = ImVec4(0.10f, 0.10f, 0.11f, 1.f);
    C[ImGuiCol_FrameBg] = ImVec4(0.16f, 0.16f, 0.18f, 1.f);
    C[ImGuiCol_FrameBgHovered] = ImVec4(0.22f, 0.22f, 0.25f, 1.f);
    C[ImGuiCol_FrameBgActive] = ImVec4(0.26f, 0.26f, 0.30f, 1.f);
    C[ImGuiCol_SliderGrab] = AccentDim; C[ImGuiCol_SliderGrabActive] = Accent; C[ImGuiCol_CheckMark] = Accent;
    C[ImGuiCol_Button] = ImVec4(0.20f, 0.20f, 0.23f, 1.f);
    C[ImGuiCol_ButtonHovered] = AccentDim; C[ImGuiCol_ButtonActive] = Accent;
    C[ImGuiCol_Header] = ImVec4(0.20f, 0.20f, 0.23f, 1.f); C[ImGuiCol_HeaderHovered] = AccentDim; C[ImGuiCol_HeaderActive] = Accent;
    C[ImGuiCol_Tab] = ImVec4(0.14f, 0.14f, 0.16f, 1.f); C[ImGuiCol_TabHovered] = AccentDim;
    C[ImGuiCol_TabSelected] = ImVec4(0.55f, 0.33f, 0.10f, 1.f);
    C[ImGuiCol_Separator] = ImVec4(0.25f, 0.25f, 0.28f, 1.f);
}

// ---------------------------------------------------------------- D3D11 / window hooks

using PresentFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT);
using ResizeFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT, UINT, DXGI_FORMAT, UINT);
static PresentFn s_OrigPresent = nullptr;
static ResizeFn s_OrigResize = nullptr;
static IDXGISwapChain* s_Sc = nullptr;
static ID3D11Device* s_Dev = nullptr;
static ID3D11DeviceContext* s_Ctx = nullptr;
static ID3D11RenderTargetView* s_Rtv = nullptr;
static HWND s_Hwnd = nullptr;
static WNDPROC s_OrigWndProc = nullptr;
static std::mutex s_ImLock;                       // ImGui is fed from the game thread and drawn on the RHI thread
static bool s_Tried = false, s_Ok = false, s_WasOpen = false;
static volatile bool s_Faulted = false;

static LRESULT CALLBACK WndProcHook(HWND H, UINT Msg, WPARAM W, LPARAM L) {
    if (G.MenuOpen.load() && G.MenuReady.load()) {
        bool Eat = false;
        {
            std::lock_guard<std::mutex> Lk(s_ImLock);
            ImGui_ImplWin32_WndProcHandler(H, Msg, W, L);
            const ImGuiIO& Io = ImGui::GetIO();
            const bool Mouse = Msg >= WM_MOUSEFIRST && Msg <= WM_MOUSELAST && Msg != WM_MOUSEMOVE;
            const bool Keys = Msg >= WM_KEYFIRST && Msg <= WM_KEYLAST;
            Eat = (Mouse && Io.WantCaptureMouse) || (Keys && Io.WantTextInput);
        }
        if (Eat) return 0;
    }
    return CallWindowProcW(s_OrigWndProc, H, Msg, W, L);
}

static bool Init(IDXGISwapChain* Sc) {
    if (FAILED(Sc->GetDevice(__uuidof(ID3D11Device), reinterpret_cast<void**>(&s_Dev)))) {
        MpLog("[CineCam] menu off: the game is not rendering with D3D11 (hotkeys and CINECAM.ini still work)");
        return false;
    }
    s_Dev->GetImmediateContext(&s_Ctx);
    DXGI_SWAP_CHAIN_DESC D{};
    Sc->GetDesc(&D);
    s_Hwnd = D.OutputWindow;
    std::lock_guard<std::mutex> Lk(s_ImLock);
    ImGui::CreateContext();
    ImGuiIO& Io = ImGui::GetIO();
    static std::string s_Ini;                       // window position, beside the exe
    {
        char Exe[MAX_PATH]{};
        GetModuleFileNameA(nullptr, Exe, MAX_PATH);
        s_Ini = std::string(Exe).substr(0, std::string(Exe).find_last_of("\\/") + 1) + "CINECAM_menu.ini";
    }
    Io.IniFilename = s_Ini.c_str();
    Io.ConfigFlags |= ImGuiConfigFlags_NoMouseCursorChange;   // the game owns the cursor shape
    if (!Io.Fonts->AddFontFromFileTTF("C:\\Windows\\Fonts\\segoeui.ttf", 18.f)) Io.Fonts->AddFontDefault();
    ApplyStyle();
    ImGui_ImplWin32_Init(s_Hwnd);
    ImGui_ImplDX11_Init(s_Dev, s_Ctx);
    s_OrigWndProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(s_Hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(WndProcHook)));
    G.MenuReady = true;
    MpLog("[CineCam] menu ready (D3D11, window " + MpPtr(s_Hwnd) + ")");
    return true;
}

static void Toast() {
    const ImVec2 Size = ImGui::GetIO().DisplaySize;
    ImGui::SetNextWindowPos(ImVec2(Size.x * 0.5f, 60.f), ImGuiCond_Always, ImVec2(0.5f, 0.f));
    ImGui::SetNextWindowBgAlpha(0.85f);
    ImGui::Begin("##toast", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoInputs
        | ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoFocusOnAppearing);
    ImGui::Text("Cinematic camera on.  Press F10 for the camera menu, F8 to exit.");
    ImGui::End();
}

static void Frame() {
    const bool Open = G.MenuOpen.load(), Toasting = GetTickCount64() < G.ToastUntil.load();
    if (!Open) { s_WasOpen = false; G.WantMouse = G.WantKeyboard = false; }
    if (!Open && !Toasting) return;
    std::lock_guard<std::mutex> Lk(s_ImLock);
    if (Open && !s_WasOpen) { s_WasOpen = true; ImGui::GetIO().ClearInputKeys(); }
    if (!s_Rtv) {
        ID3D11Texture2D* Back = nullptr;
        if (FAILED(s_Sc->GetBuffer(0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&Back)))) return;
        s_Dev->CreateRenderTargetView(Back, nullptr, &s_Rtv);
        Back->Release();
        if (!s_Rtv) return;
    }
    ImGui_ImplDX11_NewFrame();
    ImGui_ImplWin32_NewFrame();
    ImGui::NewFrame();
    if (Open) {
        std::lock_guard<std::mutex> St(G.Lock);
        DrawOverlay();
        DrawMenu();
    } else {
        Toast();
    }
    const ImGuiIO& Io = ImGui::GetIO();
    G.WantMouse = Open && Io.WantCaptureMouse;
    G.WantKeyboard = Open && Io.WantTextInput;
    ImGui::Render();
    s_Ctx->OMSetRenderTargets(1, &s_Rtv, nullptr);
    ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());
}

static void FrameGuarded() {
    __try { Frame(); }
    __except (EXCEPTION_EXECUTE_HANDLER) { s_Faulted = true; G.MenuReady = false; }
}

static HRESULT STDMETHODCALLTYPE PresentHook(IDXGISwapChain* Sc, UINT Sync, UINT Flags) {
    if (!s_Tried) { s_Tried = true; s_Sc = Sc; s_Ok = Init(Sc); }
    if (s_Ok && !s_Faulted && Sc == s_Sc) {
        FrameGuarded();
        if (s_Faulted) MpLog("[CineCam] fault in the menu - menu off for this session");
    }
    return s_OrigPresent(Sc, Sync, Flags);
}

static HRESULT STDMETHODCALLTYPE ResizeHook(IDXGISwapChain* Sc, UINT Count, UINT W, UINT H, DXGI_FORMAT Fmt, UINT Flags) {
    if (Sc == s_Sc) {
        std::lock_guard<std::mutex> Lk(s_ImLock);
        if (s_Rtv) { s_Rtv->Release(); s_Rtv = nullptr; }   // holds the back buffer; resize fails while it lives
    }
    return s_OrigResize(Sc, Count, W, H, Fmt, Flags);
}

// Present and ResizeBuffers come from the swap chain vtable (slots 8 and 13), read off a throwaway device.
void MenuStart() {
    static bool s_Started = false;
    if (s_Started) return;
    s_Started = true;
    WNDCLASSEXW Wc{ sizeof(Wc), CS_HREDRAW | CS_VREDRAW, DefWindowProcW, 0, 0, GetModuleHandleW(nullptr), nullptr, nullptr, nullptr, nullptr, L"CineCamDummy", nullptr };
    RegisterClassExW(&Wc);
    HWND Wnd = CreateWindowW(L"CineCamDummy", L"", WS_OVERLAPPEDWINDOW, 0, 0, 100, 100, nullptr, nullptr, Wc.hInstance, nullptr);
    DXGI_SWAP_CHAIN_DESC D{};
    D.BufferCount = 1;
    D.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    D.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    D.OutputWindow = Wnd;
    D.SampleDesc.Count = 1;
    D.Windowed = TRUE;
    IDXGISwapChain* Sc = nullptr;
    ID3D11Device* Dev = nullptr;
    ID3D11DeviceContext* Ctx = nullptr;
    const HRESULT Hr = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
        D3D11_SDK_VERSION, &D, &Sc, &Dev, nullptr, &Ctx);
    if (SUCCEEDED(Hr) && Sc) {
        void** Vt = *reinterpret_cast<void***>(Sc);
        const bool Ok = MH_CreateHook(Vt[8], reinterpret_cast<void*>(PresentHook), reinterpret_cast<void**>(&s_OrigPresent)) == MH_OK
            && MH_CreateHook(Vt[13], reinterpret_cast<void*>(ResizeHook), reinterpret_cast<void**>(&s_OrigResize)) == MH_OK
            && MH_EnableHook(Vt[8]) == MH_OK && MH_EnableHook(Vt[13]) == MH_OK;
        MpLog(Ok ? "[CineCam] Present hooked" : "[CineCam] Present hook failed - menu off");
    } else {
        MpLog("[CineCam] no D3D11 device for the Present hook (hr=" + std::to_string(Hr) + ") - menu off");
    }
    if (Sc) Sc->Release();
    if (Ctx) Ctx->Release();
    if (Dev) Dev->Release();
    DestroyWindow(Wnd);
    UnregisterClassW(L"CineCamDummy", Wc.hInstance);
}

}  // namespace Cine
