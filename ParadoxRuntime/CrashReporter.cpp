/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Replaces Unreal's CrashReportClient (which uploads to the original studio's collector). When the engine
// goes to launch CrashReportClient.exe, kernelbase!CreateProcessW is intercepted: this module writes its own
// report (exception, faulting module+RVA with Ghidra address, unwound stack, registers, memory, log tail),
// a minidump, copies Unreal's CrashContext.runtime-xml, uploads all three to the backend
// (PUT /crash/v1/reports/<id>/<file>, see ParadoxBackend/src/routes/crashReports.ts) and refuses the launch.
// Files are also kept in the crash folder, so a failed upload loses nothing.
// Off switch: DISABLE_CRASH_REPORTER.flag next to the game exe (the engine's own reporter then runs).
//
// A second hook on kernelbase!UnhandledExceptionFilter covers crashes where the engine's handler never gets
// as far as launching the reporter. A crash is reported once; later callers wait for it to finish.

#include <windows.h>
#include <winhttp.h>
#include <dbghelp.h>
#include <psapi.h>
#include <cstdarg>
#include <cstdio>
#include <string>
#include "MinHook/MinHook.h"
#include "RuntimeShared.h"

#pragma comment(lib, "winhttp.lib")

namespace {

constexpr ULONGLONG kExceptionMaxAgeMs = 5000;   // an older recorded exception is not this crash
constexpr DWORD kReportBudgetMs = 30000;
constexpr size_t kLogTailBytes = 24 * 1024;
constexpr size_t kContextXmlMaxBytes = 2 * 1024 * 1024;
constexpr int kMaxFrames = 48;

struct CrashParams {
    EXCEPTION_RECORD Record;
    CONTEXT Context;
    bool HaveException;
    DWORD ExceptionTid;
    ULONGLONG ExceptionAgeMs;
    DWORD CrashTid;
    void* HookFrames[kMaxFrames];
    USHORT HookFrameCount;
    wchar_t UeCrashDir[MAX_PATH];   // Unreal's UE4CC-* folder from the reporter command line, or empty
    wchar_t OutDir[MAX_PATH];
    std::string Id;
    std::string Summary;            // "NAME detail at where", for the dialog
    bool Uploaded;
};

CrashParams g_params;
struct {
    EXCEPTION_RECORD Record;
    CONTEXT Context;
    DWORD Tid;
    ULONGLONG Tick;
    volatile LONG Valid;
} g_last;

volatile LONG g_reporting = 0;   // 0 idle, 1 reporting, 2 done
ULONGLONG g_startTick = 0;

using CreateProcessWFn = BOOL(WINAPI*)(LPCWSTR, LPWSTR, LPSECURITY_ATTRIBUTES, LPSECURITY_ATTRIBUTES, BOOL, DWORD,
    LPVOID, LPCWSTR, LPSTARTUPINFOW, LPPROCESS_INFORMATION);
using UnhandledExceptionFilterFn = LONG(WINAPI*)(EXCEPTION_POINTERS*);
CreateProcessWFn g_origCreateProcessW = nullptr;
UnhandledExceptionFilterFn g_origUnhandledExceptionFilter = nullptr;

// ---------------------------------------------------------------------------------------------- text helpers

void Appendf(std::string& Out, const char* Format, ...) {
    char Buffer[1024];
    va_list Args;
    va_start(Args, Format);
    vsnprintf(Buffer, sizeof(Buffer), Format, Args);
    va_end(Args);
    Out += Buffer;
}

void AppendJsonString(std::string& Out, const std::string& Value) {
    Out += '"';
    for (unsigned char Ch : Value) {
        switch (Ch) {
        case '"': Out += "\\\""; break;
        case '\\': Out += "\\\\"; break;
        case '\n': Out += "\\n"; break;
        case '\r': Out += "\\r"; break;
        case '\t': Out += "\\t"; break;
        default:
            if (Ch < 0x20) Appendf(Out, "\\u%04x", Ch);
            else if (Ch >= 0x80) Out += '?';
            else Out += static_cast<char>(Ch);
        }
    }
    Out += '"';
}

std::string Narrow(const std::wstring& Wide) {
    std::string Out;
    for (wchar_t Ch : Wide) Out += Ch < 0x80 ? static_cast<char>(Ch) : '?';
    return Out;
}

bool ContainsI(const wchar_t* Haystack, const wchar_t* Needle) {
    if (!Haystack || !Needle) return false;
    const size_t N = wcslen(Needle);
    for (; *Haystack; ++Haystack) {
        if (_wcsnicmp(Haystack, Needle, N) == 0) return true;
    }
    return false;
}

bool ReadFileBytes(const std::wstring& Path, size_t MaxBytes, bool Tail, std::string& Out) {
    HANDLE File = CreateFileW(Path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (File == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER Size{};
    GetFileSizeEx(File, &Size);
    size_t Want = static_cast<size_t>(Size.QuadPart);
    if (Want > MaxBytes) {
        if (!Tail) { CloseHandle(File); return false; }
        LARGE_INTEGER Pos; Pos.QuadPart = Size.QuadPart - static_cast<LONGLONG>(MaxBytes);
        SetFilePointerEx(File, Pos, nullptr, FILE_BEGIN);
        Want = MaxBytes;
    }
    Out.resize(Want);
    DWORD Read = 0;
    const BOOL Ok = Want == 0 || ReadFile(File, &Out[0], static_cast<DWORD>(Want), &Read, nullptr);
    CloseHandle(File);
    Out.resize(Ok ? Read : 0);
    return Ok && Read > 0;
}

bool WriteFileBytes(const std::wstring& Path, const std::string& Data) {
    HANDLE File = CreateFileW(Path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (File == INVALID_HANDLE_VALUE) return false;
    DWORD Written = 0;
    const BOOL Ok = WriteFile(File, Data.data(), static_cast<DWORD>(Data.size()), &Written, nullptr);
    CloseHandle(File);
    return Ok && Written == Data.size();
}

std::wstring ExeDir() {
    wchar_t Path[MAX_PATH]{};
    const DWORD N = GetModuleFileNameW(nullptr, Path, MAX_PATH);
    std::wstring Dir(Path, N);
    const size_t Slash = Dir.find_last_of(L"\\/");
    return Slash == std::wstring::npos ? std::wstring() : Dir.substr(0, Slash + 1);
}

// ---------------------------------------------------------------------------------------------- what crashed

const char* ExceptionName(DWORD Code) {
    switch (Code) {
    case 0xC0000005: return "EXCEPTION_ACCESS_VIOLATION";
    case 0xC0000006: return "EXCEPTION_IN_PAGE_ERROR";
    case 0xC000001D: return "EXCEPTION_ILLEGAL_INSTRUCTION";
    case 0xC0000025: return "EXCEPTION_NONCONTINUABLE_EXCEPTION";
    case 0xC0000094: return "EXCEPTION_INT_DIVIDE_BY_ZERO";
    case 0xC0000095: return "EXCEPTION_INT_OVERFLOW";
    case 0xC0000096: return "EXCEPTION_PRIV_INSTRUCTION";
    case 0xC00000FD: return "EXCEPTION_STACK_OVERFLOW";
    case 0xC000008C: return "EXCEPTION_ARRAY_BOUNDS_EXCEEDED";
    case 0xC000008E: return "EXCEPTION_FLT_DIVIDE_BY_ZERO";
    case 0xC0000374: return "STATUS_HEAP_CORRUPTION";
    case 0xC0000409: return "STATUS_STACK_BUFFER_OVERRUN (fast fail)";
    case 0xC0000420: return "STATUS_ASSERTION_FAILURE";
    case 0x80000002: return "EXCEPTION_DATATYPE_MISALIGNMENT";
    case 0x80000003: return "EXCEPTION_BREAKPOINT";
    case 0x00000001: return "UE_FATAL_ERROR (engine check/assert/fatal log)";
    default: return "UNKNOWN_EXCEPTION";
    }
}

// Follows a chained unwind entry to the function's primary entry (a chained RUNTIME_FUNCTION is only a
// fragment of a function; see the note on MpResolveFunctionEntry in dllmain.cpp). 0 when it cannot be read.
DWORD PrimaryFunctionBegin(DWORD64 ImageBase, const RUNTIME_FUNCTION* Entry) {
    __try {
        for (int Hops = 0; Entry && Hops < 8; ++Hops) {
            const unsigned char* Info = reinterpret_cast<const unsigned char*>(ImageBase + Entry->UnwindData);
            if (!((Info[0] >> 3) & UNW_FLAG_CHAININFO)) return Entry->BeginAddress;
            Entry = reinterpret_cast<const RUNTIME_FUNCTION*>(Info + 4 + ((Info[2] + 1) & ~1) * 2);
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
    return 0;
}

// Unwinds the exception context with the OS unwind tables (no DbgHelp, no symbols needed).
USHORT UnwindStack(const CONTEXT* Start, void** Frames, USHORT MaxFrames) {
    CONTEXT Ctx = *Start;
    USHORT Count = 0;
    __try {
        while (Count < MaxFrames && Ctx.Rip != 0) {
            Frames[Count++] = reinterpret_cast<void*>(Ctx.Rip);
            DWORD64 ImageBase = 0;
            const RUNTIME_FUNCTION* Entry = RtlLookupFunctionEntry(Ctx.Rip, &ImageBase, nullptr);
            if (!Entry) {   // leaf function: return address is at [rsp]
                Ctx.Rip = *reinterpret_cast<DWORD64*>(Ctx.Rsp);
                Ctx.Rsp += 8;
                continue;
            }
            PVOID HandlerData = nullptr;
            DWORD64 EstablisherFrame = 0;
            RtlVirtualUnwind(UNW_FLAG_NHANDLER, ImageBase, Ctx.Rip, const_cast<PRUNTIME_FUNCTION>(Entry), &Ctx,
                &HandlerData, &EstablisherFrame, nullptr);
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
    return Count;
}

// "Module.dll+0xRVA fn=+0xBEGIN", plus the Ghidra address (image base 0x140000000) for the game exe.
std::string FormatFrame(void* Pc, bool CallSite) {
    const uintptr_t Address = reinterpret_cast<uintptr_t>(Pc);
    const uintptr_t Lookup = CallSite && Address ? Address - 1 : Address;
    std::string Out;
    HMODULE Module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(Lookup), &Module) || !Module) {
        Appendf(Out, "0x%llX (no module)", static_cast<unsigned long long>(Address));
        return Out;
    }
    char Path[MAX_PATH]{};
    GetModuleFileNameA(Module, Path, MAX_PATH);
    const char* Name = Path;
    for (const char* C = Path; *C; ++C) if (*C == '\\' || *C == '/') Name = C + 1;
    const uintptr_t Base = reinterpret_cast<uintptr_t>(Module);
    const bool IsGameExe = Module == GetModuleHandleW(nullptr);
    Appendf(Out, "%s+0x%llX", Name, static_cast<unsigned long long>(Address - Base));

    DWORD64 ImageBase = 0;
    const RUNTIME_FUNCTION* Entry = RtlLookupFunctionEntry(Lookup, &ImageBase, nullptr);
    const DWORD Begin = Entry ? PrimaryFunctionBegin(ImageBase, Entry) : 0;
    if (Begin) Appendf(Out, " fn=+0x%lX", Begin);
    if (IsGameExe) {
        Appendf(Out, " ghidra=0x%llX", 0x140000000ull + (Address - Base));
        if (Begin) Appendf(Out, " fn_ghidra=0x%llX", 0x140000000ull + Begin);
    }
    return Out;
}

// ---------------------------------------------------------------------------------------------- the report

std::string BuildReport(const CrashParams& P, std::string& SummaryOut) {
    SYSTEMTIME Now{};
    GetSystemTime(&Now);
    std::string Json = "{\"v\":1,\"id\":";
    AppendJsonString(Json, P.Id);
    Appendf(Json, ",\"time\":\"%04d-%02d-%02dT%02d:%02d:%02dZ\"", Now.wYear, Now.wMonth, Now.wDay, Now.wHour, Now.wMinute, Now.wSecond);
    Appendf(Json, ",\"role\":\"%s\",\"port\":%d,\"pid\":%lu,\"crashThread\":%lu", Globals::AmServer ? "server" : "client",
        Globals::Port, GetCurrentProcessId(), P.CrashTid);
    Appendf(Json, ",\"runtime\":\"build %s %s\",\"uptimeSec\":%llu", __DATE__, __TIME__, (GetTickCount64() - g_startTick) / 1000);

    std::string Where = "(no exception record; abort or fatal error without an exception)";
    std::string Regs;
    void* Frames[kMaxFrames];
    USHORT FrameCount = 0;
    bool CallSite = false;
    Json += ",\"exception\":{";
    if (P.HaveException) {
        const EXCEPTION_RECORD& R = P.Record;
        std::string Detail;
        if ((R.ExceptionCode == 0xC0000005 || R.ExceptionCode == 0xC0000006) && R.NumberParameters >= 2) {
            const ULONG_PTR Kind = R.ExceptionInformation[0];
            Appendf(Detail, "%s address 0x%llX", Kind == 0 ? "reading" : Kind == 1 ? "writing" : "executing",
                static_cast<unsigned long long>(R.ExceptionInformation[1]));
        }
        Where = FormatFrame(R.ExceptionAddress, false);
        Appendf(Json, "\"code\":\"0x%08lX\",\"name\":\"%s\",\"detail\":", R.ExceptionCode, ExceptionName(R.ExceptionCode));
        AppendJsonString(Json, Detail);
        Json += ",\"where\":";
        AppendJsonString(Json, Where);
        Appendf(Json, "},\"exceptionThread\":%lu,\"exceptionAgeMs\":%llu", P.ExceptionTid, P.ExceptionAgeMs);
        const CONTEXT& C = P.Context;
        Appendf(Regs, "rip=%llX rsp=%llX rax=%llX rcx=%llX rdx=%llX rbx=%llX rsi=%llX rdi=%llX r8=%llX r9=%llX r10=%llX r11=%llX r12=%llX r13=%llX r14=%llX r15=%llX",
            C.Rip, C.Rsp, C.Rax, C.Rcx, C.Rdx, C.Rbx, C.Rsi, C.Rdi, C.R8, C.R9, C.R10, C.R11, C.R12, C.R13, C.R14, C.R15);
        FrameCount = UnwindStack(&P.Context, Frames, kMaxFrames);
        SummaryOut = std::string(ExceptionName(R.ExceptionCode)) + (Detail.empty() ? "" : " " + Detail) + "\nat " + Where;
    } else {
        Json += "\"code\":\"none\",\"name\":\"NO_EXCEPTION_RECORD\",\"detail\":\"\",\"where\":";
        AppendJsonString(Json, Where);
        Json += "}";
        for (USHORT i = 0; i < P.HookFrameCount; ++i) Frames[i] = P.HookFrames[i];
        FrameCount = P.HookFrameCount;
        CallSite = true;
        SummaryOut = "The game stopped without an exception record.";
    }
    Json += ",\"regs\":";
    AppendJsonString(Json, Regs);

    Json += ",\"stack\":[";
    for (USHORT i = 0; i < FrameCount; ++i) {
        if (i) Json += ',';
        AppendJsonString(Json, FormatFrame(Frames[i], CallSite || i > 0));
    }
    Json += ']';

    MEMORYSTATUSEX Mem{ sizeof(Mem) };
    PROCESS_MEMORY_COUNTERS Counters{ sizeof(Counters) };
    GlobalMemoryStatusEx(&Mem);
    K32GetProcessMemoryInfo(GetCurrentProcess(), &Counters, sizeof(Counters));
    Appendf(Json, ",\"memory\":{\"physTotalMB\":%llu,\"physFreeMB\":%llu,\"virtFreeMB\":%llu,\"workingSetMB\":%llu,\"peakWorkingSetMB\":%llu,\"pagefileUseMB\":%llu}",
        Mem.ullTotalPhys >> 20, Mem.ullAvailPhys >> 20, Mem.ullAvailVirtual >> 20,
        static_cast<unsigned long long>(Counters.WorkingSetSize >> 20), static_cast<unsigned long long>(Counters.PeakWorkingSetSize >> 20),
        static_cast<unsigned long long>(Counters.PagefileUsage >> 20));

    std::string Log;
    wchar_t LogName[64];
    swprintf_s(LogName, L"mysticparadox_dll_port%d.log", Globals::Port);
    if (ReadFileBytes(ExeDir() + LogName, kLogTailBytes, true, Log)) {
        const size_t FirstLine = Log.find('\n');   // drop the partial first line of the tail
        if (FirstLine != std::string::npos && Log.size() == kLogTailBytes) Log.erase(0, FirstLine + 1);
    }
    Json += ",\"logTail\":";
    AppendJsonString(Json, Log);
    Json += ",\"ueCrashDir\":";
    AppendJsonString(Json, Narrow(P.UeCrashDir));
    Json += '}';
    return Json;
}

void WriteMinidump(const CrashParams& P, const std::wstring& Path) {
    wchar_t System[MAX_PATH]{};
    GetSystemDirectoryW(System, MAX_PATH);
    HMODULE DbgHelp = LoadLibraryW((std::wstring(System) + L"\\dbghelp.dll").c_str());
    using Fn = BOOL(WINAPI*)(HANDLE, DWORD, HANDLE, MINIDUMP_TYPE, PMINIDUMP_EXCEPTION_INFORMATION,
        PMINIDUMP_USER_STREAM_INFORMATION, PMINIDUMP_CALLBACK_INFORMATION);
    Fn Write = DbgHelp ? reinterpret_cast<Fn>(GetProcAddress(DbgHelp, "MiniDumpWriteDump")) : nullptr;
    if (!Write) return;
    HANDLE File = CreateFileW(Path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (File == INVALID_HANDLE_VALUE) return;
    EXCEPTION_POINTERS Pointers{ const_cast<EXCEPTION_RECORD*>(&P.Record), const_cast<CONTEXT*>(&P.Context) };
    MINIDUMP_EXCEPTION_INFORMATION Info{ P.ExceptionTid, &Pointers, FALSE };
    Write(GetCurrentProcess(), GetCurrentProcessId(), File,
        static_cast<MINIDUMP_TYPE>(MiniDumpNormal | MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules),
        P.HaveException ? &Info : nullptr, nullptr, nullptr);
    CloseHandle(File);
}

bool HttpPut(const std::wstring& Base, const std::string& Id, const char* FileName, const std::string& Data) {
    const std::wstring Url = Base + L"/crash/v1/reports/" + std::wstring(Id.begin(), Id.end()) + L"/"
        + std::wstring(FileName, FileName + strlen(FileName));
    wchar_t Host[256]{}, Path[512]{};
    URL_COMPONENTS Parts{ sizeof(Parts) };
    Parts.lpszHostName = Host; Parts.dwHostNameLength = 256;
    Parts.lpszUrlPath = Path; Parts.dwUrlPathLength = 512;
    if (!WinHttpCrackUrl(Url.c_str(), 0, 0, &Parts)) return false;

    bool Ok = false;
    HINTERNET Session = WinHttpOpen(L"MysticParadoxCrash/1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, nullptr, nullptr, 0);
    HINTERNET Connect = Session ? WinHttpConnect(Session, Host, Parts.nPort, 0) : nullptr;
    HINTERNET Request = Connect ? WinHttpOpenRequest(Connect, L"PUT", Path, nullptr, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES, Parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0) : nullptr;
    if (Request) {
        WinHttpSetTimeouts(Request, 3000, 3000, 15000, 15000);
        const DWORD Length = static_cast<DWORD>(Data.size());
        DWORD Status = 0, StatusSize = sizeof(Status);
        Ok = WinHttpSendRequest(Request, L"Content-Type: application/octet-stream\r\n", static_cast<DWORD>(-1),
                 const_cast<char*>(Data.data()), Length, Length, 0)
            && WinHttpReceiveResponse(Request, nullptr)
            && WinHttpQueryHeaders(Request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                   WINHTTP_HEADER_NAME_BY_INDEX, &Status, &StatusSize, WINHTTP_NO_HEADER_INDEX)
            && Status == 201;
    }
    if (Request) WinHttpCloseHandle(Request);
    if (Connect) WinHttpCloseHandle(Connect);
    if (Session) WinHttpCloseHandle(Session);
    return Ok;
}

void DoReport(CrashParams* P) {
    const std::wstring Dir = P->OutDir;
    std::string Report = BuildReport(*P, P->Summary);
    WriteFileBytes(Dir + L"\\MysticReport.json", Report);
    WriteMinidump(*P, Dir + L"\\MysticDump.dmp");
    MpLog("[CrashReporter] report " + P->Id + " written to " + Narrow(Dir) + ": " + P->Summary);

    const std::wstring Base = MpApiBaseForCrashReports();
    bool Ok = HttpPut(Base, P->Id, "report.json", Report);
    if (Ok) {
        std::string Dump;
        if (ReadFileBytes(Dir + L"\\MysticDump.dmp", 32u * 1024 * 1024, false, Dump)) HttpPut(Base, P->Id, "minidump.dmp", Dump);
        std::string Context;
        if (P->UeCrashDir[0] && ReadFileBytes(std::wstring(P->UeCrashDir) + L"\\CrashContext.runtime-xml", kContextXmlMaxBytes, false, Context))
            HttpPut(Base, P->Id, "context.xml", Context);
    }
    P->Uploaded = Ok;
    MpLog(std::string("[CrashReporter] upload ") + (Ok ? "ok" : "FAILED (report kept on disk)") + " base=" + Narrow(Base));
}

// No C++ objects with destructors here, so SEH is allowed: a fault while reporting must not hide the crash.
void GuardedDoReport(CrashParams* P) {
    __try {
        DoReport(P);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

DWORD WINAPI ReportThread(LPVOID Param) {
    GuardedDoReport(static_cast<CrashParams*>(Param));
    return 0;
}

// UE4CC-* crash folder named on the CrashReportClient command line, if any.
void ParseUeCrashDir(const wchar_t* CommandLine, wchar_t* Out) {
    Out[0] = 0;
    const wchar_t* Hit = CommandLine;
    while (Hit && *Hit && _wcsnicmp(Hit, L"UE4CC-", 6) != 0) ++Hit;
    if (!Hit || !*Hit) return;
    const wchar_t* Start = Hit;
    while (Start > CommandLine && Start[-1] != L'"' && Start[-1] != L' ') --Start;
    const wchar_t* End = Hit;
    while (*End && *End != L'"' && *End != L' ') ++End;
    const size_t Len = static_cast<size_t>(End - Start);
    if (Len > 0 && Len < MAX_PATH) { wmemcpy(Out, Start, Len); Out[Len] = 0; }
}

void ReportCrash(const wchar_t* CommandLine, EXCEPTION_POINTERS* Explicit, void** HookFrames, USHORT HookFrameCount) {
    CrashParams& P = g_params;
    P.CrashTid = GetCurrentThreadId();
    P.HookFrameCount = HookFrameCount;
    for (USHORT i = 0; i < HookFrameCount; ++i) P.HookFrames[i] = HookFrames[i];
    P.HaveException = false;
    if (Explicit && Explicit->ExceptionRecord && Explicit->ContextRecord) {
        P.Record = *Explicit->ExceptionRecord;
        P.Context = *Explicit->ContextRecord;
        P.ExceptionTid = P.CrashTid;
        P.ExceptionAgeMs = 0;
        P.HaveException = true;
    } else if (InterlockedCompareExchange(&g_last.Valid, 1, 1) && GetTickCount64() - g_last.Tick < kExceptionMaxAgeMs) {
        P.Record = g_last.Record;
        P.Context = g_last.Context;
        P.ExceptionTid = g_last.Tid;
        P.ExceptionAgeMs = GetTickCount64() - g_last.Tick;
        P.HaveException = true;
    }

    LARGE_INTEGER Counter{};
    QueryPerformanceCounter(&Counter);
    char Id[40];
    sprintf_s(Id, "%016llx%08lx%08lx", static_cast<unsigned long long>(Counter.QuadPart), GetCurrentProcessId(),
        static_cast<unsigned long>(GetTickCount64()));
    P.Id = Id;

    ParseUeCrashDir(CommandLine ? CommandLine : L"", P.UeCrashDir);
    if (P.UeCrashDir[0] && GetFileAttributesW(P.UeCrashDir) != INVALID_FILE_ATTRIBUTES) {
        wcscpy_s(P.OutDir, P.UeCrashDir);
    } else {
        wchar_t Temp[MAX_PATH]{};
        GetTempPathW(MAX_PATH, Temp);
        swprintf_s(P.OutDir, L"%sMysticCrash-%S", Temp, P.Id.substr(0, 16).c_str());
        CreateDirectoryW(P.OutDir, nullptr);
    }

    HANDLE Worker = CreateThread(nullptr, 0, ReportThread, &P, 0, nullptr);
    if (Worker) {
        WaitForSingleObject(Worker, kReportBudgetMs);
        CloseHandle(Worker);
    }

    if (!Globals::AmServer) {   // headless servers have nobody to read a dialog (and would block on it)
        std::wstring Text = L"Dauntless crashed.\n\n" + std::wstring(P.Summary.begin(), P.Summary.end()) + L"\n\n";
        Text += P.Uploaded ? L"A crash report was sent to the server (id " : L"The crash report could not be sent; it was saved to " ;
        Text += P.Uploaded ? std::wstring(P.Id.begin(), P.Id.begin() + 8) + L")." : std::wstring(P.OutDir);
        MessageBoxW(nullptr, Text.c_str(), L"Dauntless crashed", MB_OK | MB_ICONERROR | MB_TOPMOST | MB_SETFOREGROUND);
    }
}

// Runs the report once; any other crashing thread waits for it so the process is not killed mid-upload.
void ReportOnce(const wchar_t* CommandLine, EXCEPTION_POINTERS* Explicit) {
    if (InterlockedCompareExchange(&g_reporting, 1, 0) == 0) {
        void* Frames[kMaxFrames];
        const USHORT Count = CaptureStackBackTrace(0, kMaxFrames, Frames, nullptr);
        ReportCrash(CommandLine, Explicit, Frames, Count);
        InterlockedExchange(&g_reporting, 2);
        return;
    }
    for (DWORD Waited = 0; InterlockedCompareExchange(&g_reporting, 2, 2) != 2 && Waited < kReportBudgetMs + 5000; Waited += 50) Sleep(50);
}

// ---------------------------------------------------------------------------------------------- hooks

LONG WINAPI RecordException(EXCEPTION_POINTERS* Info) {
    if (!Info || !Info->ExceptionRecord || !Info->ContextRecord) return EXCEPTION_CONTINUE_SEARCH;
    const DWORD Code = Info->ExceptionRecord->ExceptionCode;
    if (Code == DBG_PRINTEXCEPTION_C || Code == DBG_PRINTEXCEPTION_WIDE_C || Code == 0x406D1388 /* thread name */ ||
        Code == 0xE06D7363 /* C++ throw */ || (Code & 0xFFFF0000) == 0x40010000 /* DBG_* */) {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    InterlockedExchange(&g_last.Valid, 0);
    g_last.Record = *Info->ExceptionRecord;
    g_last.Context = *Info->ContextRecord;
    g_last.Tid = GetCurrentThreadId();
    g_last.Tick = GetTickCount64();
    InterlockedExchange(&g_last.Valid, 1);
    return EXCEPTION_CONTINUE_SEARCH;
}

BOOL WINAPI HookCreateProcessW(LPCWSTR App, LPWSTR CommandLine, LPSECURITY_ATTRIBUTES ProcessAttrs, LPSECURITY_ATTRIBUTES ThreadAttrs,
    BOOL InheritHandles, DWORD Flags, LPVOID Env, LPCWSTR Dir, LPSTARTUPINFOW Startup, LPPROCESS_INFORMATION ProcessInfo) {
    if (ContainsI(App, L"CrashReportClient") || ContainsI(CommandLine, L"CrashReportClient")) {
        ReportOnce(CommandLine, nullptr);
        SetLastError(ERROR_FILE_NOT_FOUND);   // the engine's reporter would upload to the original studio
        return FALSE;
    }
    return g_origCreateProcessW(App, CommandLine, ProcessAttrs, ThreadAttrs, InheritHandles, Flags, Env, Dir, Startup, ProcessInfo);
}

LONG WINAPI HookUnhandledExceptionFilter(EXCEPTION_POINTERS* Info) {
    ReportOnce(nullptr, Info);
    return g_origUnhandledExceptionFilter(Info);
}

}  // namespace

void MpCrashReporterInstall() {
    static volatile LONG Installed = 0;
    if (InterlockedExchange(&Installed, 1)) return;
    if (MpExeRelativeFlagPresent(L"DISABLE_CRASH_REPORTER.flag")) {
        MpLog("[CrashReporter] disabled by DISABLE_CRASH_REPORTER.flag; the engine's reporter stays active");
        return;
    }
    g_startTick = GetTickCount64();
    AddVectoredExceptionHandler(1, RecordException);

    LPVOID Target = nullptr;
    MH_STATUS Create = MH_CreateHookApiEx(L"kernelbase.dll", "CreateProcessW", reinterpret_cast<LPVOID>(HookCreateProcessW),
        reinterpret_cast<LPVOID*>(&g_origCreateProcessW), &Target);
    MH_STATUS Enable = Create == MH_OK ? MH_EnableHook(Target) : Create;
    LPVOID FilterTarget = nullptr;
    MH_STATUS FilterCreate = MH_CreateHookApiEx(L"kernelbase.dll", "UnhandledExceptionFilter", reinterpret_cast<LPVOID>(HookUnhandledExceptionFilter),
        reinterpret_cast<LPVOID*>(&g_origUnhandledExceptionFilter), &FilterTarget);
    MH_STATUS FilterEnable = FilterCreate == MH_OK ? MH_EnableHook(FilterTarget) : FilterCreate;
    MpLog(std::string("[CrashReporter] installed CreateProcessW=") + MH_StatusToString(Create) + "/" + MH_StatusToString(Enable)
        + " UnhandledExceptionFilter=" + MH_StatusToString(FilterCreate) + "/" + MH_StatusToString(FilterEnable));
}
