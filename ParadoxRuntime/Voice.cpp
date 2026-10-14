/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// In-game party voice chat (client only). 1.14.7's own voice needs Epic's EOS RTC, and the engine's VOIP has
// no working voice interface on this build, so the runtime does it itself:
//   mic (WASAPI, default device, 48 kHz mono) -> Opus 20 ms frames -> UDP to the backend's party voice relay
//   (ParadoxBackend/src/voiceRelay.ts, wire format documented there) -> party members -> jitter buffer per
//   speaker -> mix -> WASAPI out (default device).
// The launcher passes MYSTICPARADOX_VOICE_ADDR (host:port) and MYSTICPARADOX_VOICE_TICKET; without them, or
// with DISABLE_VOIP.flag beside the exe, voice stays off. Push-to-talk key: VOIP_PTT_KEY.txt beside the exe
// (Mouse4 when missing), counted only while the game window is in front. Log tag [Voip].
// Runs on its own two threads and never touches UObjects.
//
// ponytail: no echo cancellation (use headphones), unencrypted UDP (Tailscale encrypts the path), one fixed
// 24 kbps bitrate. For proximity, put the speaker's position in 'V' and scale each speaker's gain by distance
// in MixFrame.

#include <winsock2.h>
#include <ws2tcpip.h>
#include "RuntimeShared.h"
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <atomic>
#include <cmath>
#include <deque>
#include <fstream>
#include <map>
#include <mutex>
#include <vector>
#include "opus/include/opus.h"

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "opus/lib/opus.lib")

namespace {

constexpr int RATE = 48000;
constexpr int FRAME = 960;                 // 20 ms
constexpr int RING = 64;                   // jitter slots per speaker (seq & 63)
constexpr int START_FRAMES = 3;            // buffered frames before a speaker starts playing
constexpr int MAX_FRAMES = 8;              // more than this and the oldest are skipped
constexpr int TAIL_FRAMES = 10;            // keep sending 200 ms after the key is released

SOCKET g_sock = INVALID_SOCKET;
std::string g_ticket;
std::atomic<bool> g_acked{ false };
// The game's own Audio settings (Voice chat toggle, voice chat volume), fed by MpVoiceApplySettings.
std::atomic<bool> g_enabled{ true };
std::atomic<float> g_gain{ 1.0f };

struct Speaker {
    OpusDecoder* dec = nullptr;
    struct Slot { bool valid = false; uint16_t seq = 0; std::vector<uint8_t> data; } ring[RING];
    uint16_t next = 0;
    bool started = false;
    bool any = false;
    ULONGLONG lastRx = 0;
};
std::mutex g_speakersLock;
std::map<uint32_t, Speaker> g_speakers;

int Buffered(const Speaker& s) {
    int n = 0;
    for (const auto& slot : s.ring) {
        int16_t d = static_cast<int16_t>(slot.seq - s.next);
        if (slot.valid && d >= 0 && d < RING) ++n;
    }
    return n;
}

void OnFrame(uint32_t key, uint16_t seq, const uint8_t* opus, int len) {
    std::lock_guard<std::mutex> lock(g_speakersLock);
    Speaker& s = g_speakers[key];
    if (!s.dec) {
        int err = 0;
        s.dec = opus_decoder_create(RATE, 1, &err);
        if (!s.dec) { g_speakers.erase(key); return; }
        MpLog("[Voip] hearing a new party member (key=" + std::to_string(key) + ")");
    }
    s.lastRx = GetTickCount64();
    if (!s.any) { s.any = true; s.next = seq; }
    int16_t d = static_cast<int16_t>(seq - s.next);
    if (d < 0) return;                                    // late, already played or concealed
    if (d >= RING) { for (auto& slot : s.ring) slot.valid = false; s.next = seq; s.started = false; }
    auto& slot = s.ring[seq % RING];
    slot.valid = true; slot.seq = seq; slot.data.assign(opus, opus + len);
}

// One 20 ms frame of every speaker, summed.
void MixFrame(int16_t* out) {
    std::vector<int32_t> acc(FRAME, 0);
    int16_t pcm[FRAME];
    const ULONGLONG now = GetTickCount64();
    std::lock_guard<std::mutex> lock(g_speakersLock);
    for (auto it = g_speakers.begin(); it != g_speakers.end();) {
        Speaker& s = it->second;
        if (now - s.lastRx > 30000) { opus_decoder_destroy(s.dec); it = g_speakers.erase(it); continue; }
        int buffered = Buffered(s);
        if (!s.started) {
            if (buffered >= START_FRAMES) s.started = true; else { ++it; continue; }
        }
        while (buffered > MAX_FRAMES) {                   // fell behind: skip ahead to the newest frames
            s.ring[s.next % RING].valid = false; ++s.next; buffered = Buffered(s);
        }
        auto& slot = s.ring[s.next % RING];
        int got;
        if (slot.valid && slot.seq == s.next) {
            got = opus_decode(s.dec, slot.data.data(), static_cast<opus_int32>(slot.data.size()), pcm, FRAME, 0);
            slot.valid = false;
        } else if (buffered == 0 && now - s.lastRx > 200) {
            s.started = false; ++it; continue;            // they stopped talking
        } else {
            got = opus_decode(s.dec, nullptr, 0, pcm, FRAME, 0);   // lost frame: concealment
        }
        ++s.next;
        for (int i = 0; i < got && i < FRAME; ++i) acc[i] += pcm[i];
        ++it;
    }
    const float gain = g_enabled.load() ? g_gain.load() : 0.0f;
    for (int i = 0; i < FRAME; ++i) {
        const float v = acc[i] * gain;
        out[i] = static_cast<int16_t>(v > 32767.f ? 32767 : v < -32768.f ? -32768 : v);
    }
}

// ---------------------------------------------------------------- push-to-talk

int PttKey() {
    wchar_t exe[MAX_PATH]{};
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    std::wstring path(exe);
    path = path.substr(0, path.find_last_of(L"\\/") + 1) + L"VOIP_PTT_KEY.txt";
    std::string name = "Mouse4";
    std::ifstream f(path);
    if (f) { std::string line; std::getline(f, line); line.erase(0, line.find_first_not_of(" \t\r\n\xEF\xBB\xBF")); line.erase(line.find_last_not_of(" \t\r\n") + 1); if (!line.empty()) name = line; }
    std::string up;
    for (char c : name) up += static_cast<char>(toupper(static_cast<unsigned char>(c)));
    int vk = 0;
    if (up == "MOUSE4") vk = VK_XBUTTON1;
    else if (up == "MOUSE5") vk = VK_XBUTTON2;
    else if (up == "MOUSE3") vk = VK_MBUTTON;
    else if (up.size() == 1 && (isalnum(static_cast<unsigned char>(up[0])))) vk = up[0];
    else if (up.size() >= 2 && up[0] == 'F' && atoi(up.c_str() + 1) >= 1 && atoi(up.c_str() + 1) <= 12) vk = VK_F1 + atoi(up.c_str() + 1) - 1;
    if (!vk) { MpLog("[Voip] unknown VOIP_PTT_KEY '" + name + "', using Mouse4"); vk = VK_XBUTTON1; name = "Mouse4"; }
    MpLog("[Voip] ptt key=" + name);
    return vk;
}

bool GameInFront() {
    DWORD pid = 0;
    GetWindowThreadProcessId(GetForegroundWindow(), &pid);
    return pid == GetCurrentProcessId();
}

// ---------------------------------------------------------------- network

void SendHello() {
    std::string pkt = "H" + g_ticket;
    send(g_sock, pkt.data(), static_cast<int>(pkt.size()), 0);
}

DWORD WINAPI NetThread(LPVOID) {
    char buf[1500];
    ULONGLONG lastHello = 0;
    for (;;) {
        const ULONGLONG now = GetTickCount64();
        // Voice chat off: no hellos, so the relay forgets this player after 15 s and sends nothing.
        if (now - lastHello >= 5000 && g_enabled.load()) { SendHello(); lastHello = now; }
        int n = recv(g_sock, buf, sizeof(buf), 0);
        if (n <= 0) continue;                             // timeout (SO_RCVTIMEO) or ICMP unreachable
        if (buf[0] == 'A') {
            if (!g_acked.exchange(true)) MpLog("[Voip] acked by relay");
        } else if (buf[0] == 'V' && n > 7) {
            const uint8_t* p = reinterpret_cast<const uint8_t*>(buf);
            uint32_t key = (uint32_t(p[1]) << 24) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 8) | p[4];
            uint16_t seq = static_cast<uint16_t>((p[5] << 8) | p[6]);
            OnFrame(key, seq, p + 7, n - 7);
        }
    }
}

// ---------------------------------------------------------------- audio

IAudioClient* OpenClient(EDataFlow flow, HANDLE ev, const char* label) {
    IMMDeviceEnumerator* en = nullptr;
    IMMDevice* dev = nullptr;
    IAudioClient* client = nullptr;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&en)))) return nullptr;
    HRESULT hr = en->GetDefaultAudioEndpoint(flow, eConsole, &dev);
    en->Release();
    if (FAILED(hr)) { MpLog(std::string("[Voip] no default ") + label + " device hr=" + std::to_string(hr)); return nullptr; }
    hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&client));
    dev->Release();
    if (FAILED(hr)) return nullptr;
    WAVEFORMATEX fmt{ WAVE_FORMAT_PCM, 1, RATE, RATE * 2, 2, 16, 0 };
    const DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 400000 /* 40 ms */, 0, &fmt, nullptr);
    if (SUCCEEDED(hr)) hr = client->SetEventHandle(ev);
    if (FAILED(hr)) { MpLog(std::string("[Voip] ") + label + " init failed hr=" + std::to_string(hr)); client->Release(); return nullptr; }
    MpLog(std::string("[Voip] ") + label + " open (default device, 48 kHz mono)");
    return client;
}

bool SelfTest(OpusEncoder* enc) {
    int16_t in[FRAME], out[FRAME];
    for (int i = 0; i < FRAME; ++i) in[i] = static_cast<int16_t>(8000 * sin(2 * 3.14159265 * 440 * i / RATE));
    unsigned char pkt[400];
    int len = opus_encode(enc, in, FRAME, pkt, sizeof(pkt));
    int err = 0;
    OpusDecoder* dec = opus_decoder_create(RATE, 1, &err);
    int got = dec && len > 0 ? opus_decode(dec, pkt, len, out, FRAME, 0) : -1;
    if (dec) opus_decoder_destroy(dec);
    opus_encoder_ctl(enc, OPUS_RESET_STATE);
    return got == FRAME;
}

DWORD WINAPI AudioThread(LPVOID) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    int err = 0;
    OpusEncoder* enc = opus_encoder_create(RATE, 1, OPUS_APPLICATION_VOIP, &err);
    if (!enc) { MpLog("[Voip] opus encoder failed err=" + std::to_string(err)); return 0; }
    opus_encoder_ctl(enc, OPUS_SET_BITRATE(24000));
    opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC(1));
    opus_encoder_ctl(enc, OPUS_SET_PACKET_LOSS_PERC(10));
    MpLog(SelfTest(enc) ? "[Voip] selftest ok" : "[Voip] selftest FAILED");
    const int ptt = PttKey();

    HANDLE capEv = CreateEventW(nullptr, FALSE, FALSE, nullptr), renEv = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    IAudioClient* cap = OpenClient(eCapture, capEv, "mic");
    IAudioClient* ren = OpenClient(eRender, renEv, "speaker");
    IAudioCaptureClient* capC = nullptr;
    IAudioRenderClient* renC = nullptr;
    if (cap && FAILED(cap->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capC)))) capC = nullptr;
    if (ren && FAILED(ren->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(&renC)))) renC = nullptr;
    UINT32 renSize = 0;
    if (ren) ren->GetBufferSize(&renSize);
    if (capC) cap->Start();
    if (renC) ren->Start();

    std::vector<int16_t> micFifo;
    std::deque<int16_t> playFifo;
    uint16_t seq = 0;
    int tail = 0;
    bool loggedTx = false;
    HANDLE evs[2] = { capEv, renEv };
    for (;;) {
        DWORD w = WaitForMultipleObjects(2, evs, FALSE, 100);
        if (capC && (w == WAIT_OBJECT_0 || w == WAIT_TIMEOUT)) {
            BYTE* data; UINT32 frames; DWORD flags;
            while (SUCCEEDED(capC->GetBuffer(&data, &frames, &flags, nullptr, nullptr)) && frames > 0) {
                const int16_t* s = reinterpret_cast<const int16_t*>(data);
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) micFifo.insert(micFifo.end(), frames, 0);
                else micFifo.insert(micFifo.end(), s, s + frames);
                capC->ReleaseBuffer(frames);
            }
            while (micFifo.size() >= FRAME) {
                const bool held = (GetAsyncKeyState(ptt) & 0x8000) && GameInFront();
                tail = held ? TAIL_FRAMES : (tail > 0 ? tail - 1 : 0);
                if (tail > 0 && g_acked.load() && g_enabled.load()) {
                    unsigned char pkt[3 + 400];
                    int len = opus_encode(enc, micFifo.data(), FRAME, pkt + 3, 400);
                    if (len > 0) {
                        pkt[0] = 'V'; pkt[1] = static_cast<unsigned char>(seq >> 8); pkt[2] = static_cast<unsigned char>(seq);
                        ++seq;
                        send(g_sock, reinterpret_cast<const char*>(pkt), len + 3, 0);
                        if (!loggedTx) { loggedTx = true; MpLog("[Voip] first frame sent"); }
                    }
                }
                micFifo.erase(micFifo.begin(), micFifo.begin() + FRAME);
            }
        }
        if (renC && (w == WAIT_OBJECT_0 + 1 || w == WAIT_TIMEOUT)) {
            UINT32 pad = 0;
            if (FAILED(ren->GetCurrentPadding(&pad))) continue;
            UINT32 want = renSize - pad;
            while (playFifo.size() < want) {
                int16_t frame[FRAME];
                MixFrame(frame);
                playFifo.insert(playFifo.end(), frame, frame + FRAME);
            }
            BYTE* data;
            if (want > 0 && SUCCEEDED(renC->GetBuffer(want, &data))) {
                int16_t* d = reinterpret_cast<int16_t*>(data);
                for (UINT32 i = 0; i < want; ++i) { d[i] = playFifo.front(); playFifo.pop_front(); }
                renC->ReleaseBuffer(want, 0);
            }
        }
    }
}

} // namespace

void MpVoiceApplySettings(bool enabled, float volume) {
    // The game's voice chat slider defaults to 0.5; make that unity gain (full slider = 2x).
    const float gain = (volume < 0.f ? 0.f : volume > 1.f ? 1.f : volume) * 2.0f;
    if (g_enabled.exchange(enabled) != enabled) {
        MpLog(std::string("[Voip] voice chat ") + (enabled ? "on" : "off") + " (game Audio setting)");
        if (enabled) SendHello();
    }
    g_gain.store(gain);
}

void MpVoiceStart() {
    if (Globals::AmServer || MpExeRelativeFlagPresent(L"DISABLE_VOIP.flag")) return;
    char addr[300]{}, ticket[4096]{};
    DWORD al = GetEnvironmentVariableA("MYSTICPARADOX_VOICE_ADDR", addr, sizeof(addr));
    DWORD tl = GetEnvironmentVariableA("MYSTICPARADOX_VOICE_TICKET", ticket, sizeof(ticket));
    if (al == 0 || al >= sizeof(addr) || tl == 0 || tl >= sizeof(ticket)) { MpLog("[Voip] off (no voice relay from the launcher)"); return; }
    std::string a(addr);
    const size_t colon = a.find_last_of(':');
    if (colon == std::string::npos) { MpLog("[Voip] off (bad MYSTICPARADOX_VOICE_ADDR)"); return; }
    const std::string host = a.substr(0, colon), port = a.substr(colon + 1);
    g_ticket = ticket;

    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET; hints.ai_socktype = SOCK_DGRAM;
    if (getaddrinfo(host.c_str(), port.c_str(), &hints, &res) != 0 || !res) { MpLog("[Voip] off (cannot resolve " + host + ")"); return; }
    g_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    const bool ok = g_sock != INVALID_SOCKET && connect(g_sock, res->ai_addr, static_cast<int>(res->ai_addrlen)) == 0;
    freeaddrinfo(res);
    if (!ok) { MpLog("[Voip] off (socket error " + std::to_string(WSAGetLastError()) + ")"); return; }
    DWORD timeout = 500;
    setsockopt(g_sock, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));

    MpLog("[Voip] starting, relay " + host + ":" + port);
    CreateThread(nullptr, 0, NetThread, nullptr, 0, nullptr);
    CreateThread(nullptr, 0, AudioThread, nullptr, 0, nullptr);
}
