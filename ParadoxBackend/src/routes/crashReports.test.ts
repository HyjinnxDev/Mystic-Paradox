import assert from "node:assert/strict";
import test from "node:test";
import { crashIssueTitle, crashSignature, formatCrashSummary } from "./crashReports";

test("crash summary names the fault, location and stack", () => {
    const out = formatCrashSummary({
        exception: { name: "EXCEPTION_ACCESS_VIOLATION", code: "0xC0000005", detail: "reading address 0x20", where: "Dauntless-Win64-Shipping.exe+0x4272D28", ghidra: "0x144272D28" },
        stack: ["Dauntless-Win64-Shipping.exe+0x4272D28 fn=+0x4272B00", "MysticParadox.dll+0x89894 fn=+0x89800"],
        logTail: "[LoadMapPL] ENTER map=x",
    });
    assert.match(out, /EXCEPTION_ACCESS_VIOLATION \(0xC0000005\) reading address 0x20/);
    assert.match(out, /where:   Dauntless-Win64-Shipping.exe\+0x4272D28  ghidra 0x144272D28/);
    assert.match(out, /MysticParadox.dll\+0x89894/);
    assert.match(out, /\[LoadMapPL\] ENTER/);
});

test("same function groups together, different function or exception does not", () => {
    const at = (name: string, where: string) => ({ exception: { name, where } });
    const game = (addr: string) => at("AV", `Dauntless-Win64-Shipping.exe+${addr} fn=+0x4272B00 ghidra=0x1 fn_ghidra=0x144272B00`);
    assert.equal(crashSignature(game("0x4272D28")), crashSignature(game("0x4272D40")));
    assert.notEqual(crashSignature(game("0x4272D28")), crashSignature(at("AV", "Dauntless-Win64-Shipping.exe+0x1 fn=+0x2 fn_ghidra=0x144000000")));
    assert.notEqual(crashSignature(game("0x4272D28")), crashSignature({ exception: { name: "STACK_OVERFLOW", where: game("0x4272D28").exception.where } }));
    assert.equal(crashSignature(at("AV", "MysticParadox.dll+0x89894 fn=+0x89800")), crashSignature(at("AV", "MysticParadox.dll+0x89899 fn=+0x89800")));
    assert.match(crashIssueTitle(at("AV", "x+0x1")), /^AV at x\+0x1$/);
});
