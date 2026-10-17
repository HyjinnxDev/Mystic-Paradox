/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

#pragma once

#include <windows.h>
#include <cstdint>
#include <string>
#include <vector>

// Helpers and globals defined in dllmain.cpp that the runtime's other source files may use.

namespace Globals {
    extern bool AmServer;
    extern uintptr_t BaseAddress;
    extern int Port;
    // DeployServer roster: "accountId:..., accountId:..." (null outside a DeployServer launch).
    extern const wchar_t* ExpectedPlayerString;
}

// Flushed per-port diagnostic log next to the game executable (mysticparadox_dll_port<N>.log).
void MpLog(const std::string& Msg);
std::string MpPtr(const void* Ptr);
// Reads an environment variable of at most Maximum characters without control characters.
bool MpReadEnvironment(const char* Name, std::string& Value, size_t Maximum);
// True iff <game-exe-dir>\<FileName> exists.
bool MpExeRelativeFlagPresent(const wchar_t* FileName);
// MYSTICPARADOX_RUNTIME_PROFILE=development, injected only by the launcher.
bool DevelopmentRuntimeProfile();

bool IsReadablePointer(const void* Ptr, size_t Size = sizeof(void*));
// True while Ptr is a live UObject (its GObjects slot still points at it).
bool IsRegisteredLiveObject(const void* Ptr);
std::string SafeObjectNameForDiagnostic(void* Object);
// Narrow copy of a UE FString (ASCII content), guarded and bounded.
std::string CoreCapFString(void* fstr);

// CrashReporter.cpp: replaces the engine's CrashReportClient (see the header comment there).
void MpCrashReporterInstall();
// Backend base URL the runtime talks to (scheme://host:port), including the launcher relay override.
std::wstring MpApiBaseForCrashReports();

// Voice.cpp: in-game party voice chat (client only; off without the launcher's voice relay env).
void MpVoiceStart();
// JoinPrompt.cpp: join-in-progress offer (client only). Worker thread <-> game thread (dllmain.cpp JoinPopup):
// take a new offer's popup text / a result notice once each, answer the popup.
void MpJoinPromptStart();
bool MpJoinPromptTakeOffer(std::string& Text);
bool MpJoinPromptTakeNotice(std::string& Text);
void MpJoinPromptAnswer(bool Join);
// Game thread -> voice threads: the game's Audio "Voice chat" toggle and voice chat volume (0..1).
void MpVoiceApplySettings(bool enabled, float volume);
// Game thread -> voice threads: the Bindings "Push to Talk" key (a VK code, 0 = unusable) and the Audio Open Mic toggle.
void MpVoiceSetPttKey(int vk);
void MpVoiceSetOpenMic(bool open);
// Game thread -> voice threads: the social (O) menu's mic mute button; muted = nothing sent in either mode.
void MpVoiceSetSelfMuted(bool muted);
// Voice threads -> game thread, for the talking icons: this player 0 = silent/voice off, 1 = sending, 2 = muted;
// another player's relay sender key (from their account id) and whether their voice is arriving right now.
int MpVoiceSelfState();
uint32_t MpVoiceKeyForId(const std::string& id);
bool MpVoiceKeyTalking(uint32_t key);
// Game thread -> voice threads: this player's pawn location (UE units) and camera yaw (degrees), for proximity pan/fade.
void MpVoiceSetListener(bool valid, float x, float y, float z, float yawDegrees);
// Hub server only: report every connected player's backend account id and location to the voice relay, which
// decides proximity from these alone (HMAC-signed with the gameserver API key).
struct MpVoicePos { std::string id; float x, y, z; };
void MpVoiceServerStart(const std::string& apiKey, uint16_t gamePort);
void MpVoiceReportPositions(const std::vector<MpVoicePos>& players);

// Game thread: UKismetSystemLibrary::QuitGame on the current world.
void MpQuitGame();
