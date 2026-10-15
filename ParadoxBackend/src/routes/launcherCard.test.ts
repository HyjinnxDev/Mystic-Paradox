import assert from "node:assert/strict";
import test from "node:test";
import { CleanCardText, InviteFor, LogoType, MAX_TITLE } from "./launcherCard";

test("launcher card text is cleaned and capped; logos are sniffed; invites match the launcher format", () => {
    assert.deepEqual(CleanCardText({ title: "  Hyjinnx's‮  Ramsgate ", motd: "Hunts nightly\r\n\r\n\r\n\u0007Be nice" }), { title: "Hyjinnx's Ramsgate", motd: "Hunts nightly\n\nBe nice" });
    assert.equal(CleanCardText({ title: "x".repeat(MAX_TITLE + 1), motd: "" }), null);
    assert.equal(CleanCardText({ title: 1, motd: "" }), null);
    assert.equal(LogoType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
    assert.equal(LogoType(Buffer.from("<svg onload=alert(1)>")), null);
    const I = InviteFor("100.108.36.34", 443, "a".repeat(64), "CODE-1", "Friday Hunts");
    assert.equal(I.invite, `dauntless-forever-1147://join?v=1&host=100.108.36.34&port=443&fp=${"a".repeat(64)}&code=CODE-1&name=Friday%20Hunts`);
    assert.ok(I.link.endsWith(`/join/#${I.invite.split("?")[1]}`));
});
