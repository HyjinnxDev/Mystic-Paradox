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
// with DISABLE_VOIP.flag beside the exe, voice stays off. The game thread (dllmain.cpp VoiceSettings) feeds the
// options menu: Voice chat on/off + volume, the Bindings "Push to Talk" key (counted only while the game window is
// in front), and the Audio "Open Mic" toggle (then a level gate decides when to send). Log tag [Voip].
// Runs on its own two threads and never touches UObjects.
//
// Proximity (hub servers only): the hub's server runtime reports every connected player's account id and
// location to the relay (MpVoiceReportPositions, HMAC-signed with the gameserver key); the relay alone decides
// who is near enough to hear whom and stamps the speaker's location on each frame ('W'). This client only
// shapes what it was sent: volume by distance and left/right pan from its own pawn and camera (MpVoiceSetListener).
// Party members are always at full volume.
//
// ponytail: no echo cancellation (use headphones), unencrypted UDP (Tailscale encrypts the path), one fixed
// 24 kbps bitrate, stereo pan only (no front/back or occlusion).

#include <winsock2.h>
#include <ws2tcpip.h>
#include "RuntimeShared.h"
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <bcrypt.h>
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
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "opus/lib/opus.lib")

namespace {

constexpr int RATE = 48000;
constexpr int FRAME = 960;                 // 20 ms
constexpr int RING = 64;                   // jitter slots per speaker (seq & 63)
constexpr int START_FRAMES = 3;            // buffered frames before a speaker starts playing
constexpr int MAX_FRAMES = 8;              // more than this and the oldest are skipped
constexpr int TAIL_FRAMES = 10;            // keep sending 200 ms after the key is released
constexpr float FULL_VOLUME_UU = 800.f;    // proximity: full volume within 8 m ...
constexpr float SILENT_UU = 4000.f;        // ... silent at 40 m (the relay's HEAR_RADIUS)

SOCKET g_sock = INVALID_SOCKET;
std::string g_ticket;
std::atomic<bool> g_acked{ false };
// The game's own Audio settings (Voice chat toggle, voice chat volume), fed by MpVoiceApplySettings.
std::atomic<bool> g_enabled{ true };
std::atomic<float> g_gain{ 1.0f };

// This player's own pawn location and camera yaw, fed by MpVoiceSetListener.
struct Listener { bool valid = false; float x = 0, y = 0, z = 0, yaw = 0; };
std::mutex g_listenerLock;
Listener g_listener;

struct Speaker {
    OpusDecoder* dec = nullptr;
    struct Slot { bool valid = false; uint16_t seq = 0; std::vector<uint8_t> data; } ring[RING];
    uint16_t next = 0;
    bool started = false;
    bool any = false;
    ULONGLONG lastRx = 0;
    uint8_t flags = 0;                     // 'W' flags of the newest frame: 1 = has position, 2 = party
    float x = 0, y = 0, z = 0;
    float gl = 1.f, gr = 1.f;              // gains applied last frame, ramped from to avoid clicks
};
std::mutex g_speakersLock;
std::map<uint32_t, Speaker> g_speakers;

// Left/right gain for one speaker. Centre is 1/1 (as loud as the old mono mix); a hard pan reaches ~1.41 on one side.
void SpeakerGains(const Speaker& s, const Listener& me, float& l, float& r) {
    l = r = 1.f;
    if (!(s.flags & 1) || !me.valid) return;
    const float dx = s.x - me.x, dy = s.y - me.y, dz = s.z - me.z;
    const float d = sqrtf(dx * dx + dy * dy + dz * dz);
    float g = 1.f;
    if (!(s.flags & 2) && d > FULL_VOLUME_UU) {
        const float t = d >= SILENT_UU ? 0.f : 1.f - (d - FULL_VOLUME_UU) / (SILENT_UU - FULL_VOLUME_UU);
        g = t * t;
    }
    const float flat = sqrtf(dx * dx + dy * dy);
    const float yaw = me.yaw * 3.14159265f / 180.f;
    float pan = flat > 1.f ? (-sinf(yaw) * dx + cosf(yaw) * dy) / flat : 0.f;   // UE: +Y is right of +X
    pan = pan < -1.f ? -1.f : pan > 1.f ? 1.f : pan;
    const float a = (pan + 1.f) * 3.14159265f / 4.f;                            // equal-power
    l = g * cosf(a) * 1.41421356f;
    r = g * sinf(a) * 1.41421356f;
}

int Buffered(const Speaker& s) {
    int n = 0;
    for (const auto& slot : s.ring) {
        int16_t d = static_cast<int16_t>(slot.seq - s.next);
        if (slot.valid && d >= 0 && d < RING) ++n;
    }
    return n;
}

void OnFrame(uint32_t key, uint16_t seq, uint8_t flags, const float* pos, const uint8_t* opus, int len) {
    std::lock_guard<std::mutex> lock(g_speakersLock);
    Speaker& s = g_speakers[key];
    if (!s.dec) {
        int err = 0;
        s.dec = opus_decoder_create(RATE, 1, &err);
        if (!s.dec) { g_speakers.erase(key); return; }
        MpLog("[Voip] hearing a new " + std::string(flags & 2 ? "party member" : "nearby player") + " (key=" + std::to_string(key) + ")");
    }
    s.lastRx = GetTickCount64();
    s.flags = flags;
    if (pos) { s.x = pos[0]; s.y = pos[1]; s.z = pos[2]; }
    if (!s.any) { s.any = true; s.next = seq; }
    int16_t d = static_cast<int16_t>(seq - s.next);
    if (d < 0) return;                                    // late, already played or concealed
    if (d >= RING) { for (auto& slot : s.ring) slot.valid = false; s.next = seq; s.started = false; }
    auto& slot = s.ring[seq % RING];
    slot.valid = true; slot.seq = seq; slot.data.assign(opus, opus + len);
}

// One 20 ms frame of every speaker, panned and summed: FRAME interleaved stereo samples (L, R) into out.
void MixFrame(int16_t* out) {
    std::vector<float> acc(FRAME * 2, 0.f);
    int16_t pcm[FRAME];
    const ULONGLONG now = GetTickCount64();
    Listener me;
    { std::lock_guard<std::mutex> l(g_listenerLock); me = g_listener; }
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
        float gl, gr;
        SpeakerGains(s, me, gl, gr);
        for (int i = 0; i < got && i < FRAME; ++i) {
            const float t = float(i) / FRAME;
            acc[2 * i] += pcm[i] * (s.gl + (gl - s.gl) * t);
            acc[2 * i + 1] += pcm[i] * (s.gr + (gr - s.gr) * t);
        }
        s.gl = gl; s.gr = gr;
        ++it;
    }
    const float gain = g_enabled.load() ? g_gain.load() : 0.0f;
    for (int i = 0; i < FRAME * 2; ++i) {
        const float v = acc[i] * gain;
        out[i] = static_cast<int16_t>(v > 32767.f ? 32767 : v < -32768.f ? -32768 : v);
    }
}

// ---------------------------------------------------------------- push-to-talk

std::atomic<int> g_pttVk{ VK_XBUTTON1 };       // Mouse4 until the game's binding is read
std::atomic<bool> g_openMic{ false };
std::atomic<bool> g_selfMuted{ false };
std::atomic<bool> g_selfSending{ false };       // frames going out right now (talking indicator)
constexpr int OPEN_MIC_GATE_RMS = 400;          // ~-38 dBFS; quieter frames are not sent in open-mic mode

int FrameRms(const int16_t* pcm) {
    double sum = 0;
    for (int i = 0; i < FRAME; ++i) sum += double(pcm[i]) * pcm[i];
    return static_cast<int>(sqrt(sum / FRAME));
}

bool GameInFront() {
    DWORD pid = 0;
    GetWindowThreadProcessId(GetForegroundWindow(), &pid);
    return pid == GetCurrentProcessId();
}

// ---------------------------------------------------------------- network

uint32_t ReadU32(const uint8_t* p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }

void PutU32(std::string& out, uint32_t v) { for (int s = 24; s >= 0; s -= 8) out.push_back(static_cast<char>(v >> s)); }

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
        } else if (buf[0] == 'W' && n > 8) {
            const uint8_t* p = reinterpret_cast<const uint8_t*>(buf);
            uint32_t key = ReadU32(p + 1);
            uint16_t seq = static_cast<uint16_t>((p[5] << 8) | p[6]);
            const uint8_t flags = p[7];
            if (flags & 1) {
                if (n <= 20) continue;
                float pos[3];
                for (int i = 0; i < 3; ++i) { uint32_t u = ReadU32(p + 8 + 4 * i); memcpy(&pos[i], &u, 4); }
                OnFrame(key, seq, flags, pos, p + 20, n - 20);
            } else {
                OnFrame(key, seq, flags, nullptr, p + 8, n - 8);
            }
        }
    }
}

// ---------------------------------------------------------------- audio

IAudioClient* OpenClient(EDataFlow flow, HANDLE ev, const char* label, WORD channels) {
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
    WAVEFORMATEX fmt{ WAVE_FORMAT_PCM, channels, RATE, RATE * 2u * channels, static_cast<WORD>(2 * channels), 16, 0 };
    const DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 400000 /* 40 ms */, 0, &fmt, nullptr);
    if (SUCCEEDED(hr)) hr = client->SetEventHandle(ev);
    if (FAILED(hr)) { MpLog(std::string("[Voip] ") + label + " init failed hr=" + std::to_string(hr)); client->Release(); return nullptr; }
    MpLog(std::string("[Voip] ") + label + " open (default device, 48 kHz " + (channels == 2 ? "stereo" : "mono") + ")");
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


    HANDLE capEv = CreateEventW(nullptr, FALSE, FALSE, nullptr), renEv = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    IAudioClient* cap = OpenClient(eCapture, capEv, "mic", 1);
    IAudioClient* ren = OpenClient(eRender, renEv, "speaker", 2);
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
                const int vk = g_pttVk.load();
                const bool muted = g_selfMuted.load();
                const bool talking = !muted && (g_openMic.load()
                    ? FrameRms(micFifo.data()) >= OPEN_MIC_GATE_RMS
                    : vk && (GetAsyncKeyState(vk) & 0x8000) && GameInFront());
                tail = talking ? TAIL_FRAMES : (tail > 0 && !muted ? tail - 1 : 0);
                g_selfSending.store(tail > 0 && g_acked.load() && g_enabled.load());
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
            UINT32 want = renSize - pad;                      // stereo frames; playFifo holds interleaved samples
            while (playFifo.size() < want * 2) {
                int16_t frame[FRAME * 2];
                MixFrame(frame);
                playFifo.insert(playFifo.end(), frame, frame + FRAME * 2);
            }
            BYTE* data;
            if (want > 0 && SUCCEEDED(renC->GetBuffer(want, &data))) {
                int16_t* d = reinterpret_cast<int16_t*>(data);
                for (UINT32 i = 0; i < want * 2; ++i) { d[i] = playFifo.front(); playFifo.pop_front(); }
                renC->ReleaseBuffer(want, 0);
            }
        }
    }
}

// A UDP socket connected to "host:port", or INVALID_SOCKET (logged).
SOCKET OpenRelaySocket(const std::string& hostPort) {
    const size_t colon = hostPort.find_last_of(':');
    if (colon == std::string::npos) { MpLog("[Voip] bad relay address"); return INVALID_SOCKET; }
    const std::string host = hostPort.substr(0, colon), port = hostPort.substr(colon + 1);
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET; hints.ai_socktype = SOCK_DGRAM;
    if (getaddrinfo(host.c_str(), port.c_str(), &hints, &res) != 0 || !res) { MpLog("[Voip] cannot resolve " + host); return INVALID_SOCKET; }
    SOCKET s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    const bool ok = s != INVALID_SOCKET && connect(s, res->ai_addr, static_cast<int>(res->ai_addrlen)) == 0;
    freeaddrinfo(res);
    if (!ok) { MpLog("[Voip] socket error " + std::to_string(WSAGetLastError())); if (s != INVALID_SOCKET) closesocket(s); return INVALID_SOCKET; }
    return s;
}

// ---------------------------------------------------------------- hub server: position reports

SOCKET g_srvSock = INVALID_SOCKET;
std::string g_srvKey;
uint16_t g_srvPort = 0;
uint64_t g_srvLastTs = 0;
BCRYPT_ALG_HANDLE g_hmacAlg = nullptr;

bool HmacSha256(const std::string& key, const std::string& data, unsigned char out[32]) {
    BCRYPT_HASH_HANDLE h = nullptr;
    bool ok = BCRYPT_SUCCESS(BCryptCreateHash(g_hmacAlg, &h, nullptr, 0, (PUCHAR)key.data(), static_cast<ULONG>(key.size()), 0))
        && BCRYPT_SUCCESS(BCryptHashData(h, (PUCHAR)data.data(), static_cast<ULONG>(data.size()), 0))
        && BCRYPT_SUCCESS(BCryptFinishHash(h, out, 32, 0));
    if (h) BCryptDestroyHash(h);
    return ok;
}

uint64_t EpochMs() {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    return ((uint64_t(ft.dwHighDateTime) << 32 | ft.dwLowDateTime) - 116444736000000000ull) / 10000;
}

void SendReport(const std::vector<MpVoicePos>& players, size_t from, size_t to) {
    uint64_t ts = EpochMs();
    if (ts <= g_srvLastTs) ts = g_srvLastTs + 1;                   // the relay rejects a ts it has seen
    g_srvLastTs = ts;
    std::string pkt = "P";
    PutU32(pkt, static_cast<uint32_t>(ts >> 32)); PutU32(pkt, static_cast<uint32_t>(ts));
    pkt.push_back(static_cast<char>(g_srvPort >> 8)); pkt.push_back(static_cast<char>(g_srvPort));
    pkt.push_back(static_cast<char>(to - from));
    for (size_t i = from; i < to; ++i) {
        const MpVoicePos& p = players[i];
        pkt.push_back(static_cast<char>(p.id.size()));
        pkt += p.id;
        for (float f : { p.x, p.y, p.z }) { uint32_t u; memcpy(&u, &f, 4); PutU32(pkt, u); }
    }
    unsigned char mac[32];
    if (!HmacSha256(g_srvKey, pkt, mac)) return;
    pkt.append(reinterpret_cast<const char*>(mac), 32);
    send(g_srvSock, pkt.data(), static_cast<int>(pkt.size()), 0);
}

} // namespace

void MpVoiceServerStart(const std::string& apiKey, uint16_t gamePort) {
    if (g_srvSock != INVALID_SOCKET || apiKey.empty() || MpExeRelativeFlagPresent(L"DISABLE_VOIP.flag")) return;
    if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&g_hmacAlg, BCRYPT_SHA256_ALGORITHM, nullptr, BCRYPT_ALG_HANDLE_HMAC_FLAG))) {
        MpLog("[Voip] proximity off (no HMAC provider)");
        return;
    }
    // The relay runs inside the backend; hubs are launched on the same machine unless MYSTICPARADOX_VOICE_RELAY says otherwise.
    char addr[300]{};
    const DWORD al = GetEnvironmentVariableA("MYSTICPARADOX_VOICE_RELAY", addr, sizeof(addr));
    const std::string relay = al > 0 && al < sizeof(addr) ? std::string(addr) : "127.0.0.1:8791";
    g_srvSock = OpenRelaySocket(relay);
    if (g_srvSock == INVALID_SOCKET) { MpLog("[Voip] proximity off (no relay socket)"); return; }
    g_srvKey = apiKey;
    g_srvPort = gamePort;
    MpLog("[Voip] hub proximity reports -> " + relay + " (game port " + std::to_string(gamePort) + ")");
}

void MpVoiceReportPositions(const std::vector<MpVoicePos>& players) {
    if (g_srvSock == INVALID_SOCKET) return;
    // 20 players per packet (ids <= 64 B -> under the relay's 1200 B cap). Nobody reported = everyone's position
    // expires at the relay within 1.5 s.
    for (size_t i = 0; i < players.size(); i += 20) SendReport(players, i, (std::min)(players.size(), i + 20));
}

void MpVoiceSetListener(bool valid, float x, float y, float z, float yawDegrees) {
    std::lock_guard<std::mutex> l(g_listenerLock);
    g_listener = { valid, x, y, z, yawDegrees };
}

void MpVoiceApplySettings(bool enabled, float volume) {
    // The game's voice chat slider defaults to 0.5; make that unity gain (full slider = 2x).
    const float gain = (volume < 0.f ? 0.f : volume > 1.f ? 1.f : volume) * 2.0f;
    if (g_enabled.exchange(enabled) != enabled) {
        MpLog(std::string("[Voip] voice chat ") + (enabled ? "on" : "off") + " (game Audio setting)");
        if (enabled) SendHello();
    }
    g_gain.store(gain);
}

void MpVoiceSetPttKey(int vk) { g_pttVk.store(vk); }

void MpVoiceSetOpenMic(bool open) {
    if (g_openMic.exchange(open) != open) MpLog(std::string("[Voip] mode ") + (open ? "open mic" : "push to talk"));
}

void MpVoiceSetSelfMuted(bool muted) {
    if (g_selfMuted.exchange(muted) != muted) MpLog(std::string("[Voip] mic ") + (muted ? "muted" : "unmuted") + " (social menu)");
}

int MpVoiceSelfState() {
    if (g_sock == INVALID_SOCKET || !g_enabled.load()) return 0;
    return g_selfMuted.load() ? 2 : g_selfSending.load() ? 1 : 0;
}

// Same as the relay's SenderKey: the first 4 bytes (big-endian) of sha256(account id).
uint32_t MpVoiceKeyForId(const std::string& id) {
    unsigned char h[32]{};
    BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0, (PUCHAR)id.data(), static_cast<ULONG>(id.size()), h, 32);
    return ReadU32(h);
}

bool MpVoiceKeyTalking(uint32_t key) {
    std::lock_guard<std::mutex> lock(g_speakersLock);
    auto it = g_speakers.find(key);
    return it != g_speakers.end() && it->second.started && GetTickCount64() - it->second.lastRx < 400;
}

void MpVoiceStart() {
    if (Globals::AmServer || MpExeRelativeFlagPresent(L"DISABLE_VOIP.flag")) return;
    char addr[300]{}, ticket[4096]{};
    DWORD al = GetEnvironmentVariableA("MYSTICPARADOX_VOICE_ADDR", addr, sizeof(addr));
    DWORD tl = GetEnvironmentVariableA("MYSTICPARADOX_VOICE_TICKET", ticket, sizeof(ticket));
    if (al == 0 || al >= sizeof(addr) || tl == 0 || tl >= sizeof(ticket)) { MpLog("[Voip] off (no voice relay from the launcher)"); return; }
    g_ticket = ticket;
    g_sock = OpenRelaySocket(addr);
    if (g_sock == INVALID_SOCKET) { MpLog("[Voip] off (no relay socket)"); return; }
    DWORD timeout = 500;
    setsockopt(g_sock, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeout), sizeof(timeout));

    MpLog("[Voip] starting, relay " + std::string(addr));
    CreateThread(nullptr, 0, NetThread, nullptr, 0, nullptr);
    CreateThread(nullptr, 0, AudioThread, nullptr, 0, nullptr);
}
