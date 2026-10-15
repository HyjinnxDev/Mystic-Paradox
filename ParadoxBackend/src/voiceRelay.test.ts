/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import dgram from "node:dgram";
import { once } from "node:events";
import { HEAR_RADIUS, ParsePositionReport, SenderKey, SignVoiceTicket, StartVoiceRelay, ValidateVoiceTicket, VoiceRelayState } from "./voiceRelay";

// Builds a hub position report exactly as ParadoxRuntime/Voice.cpp MpVoiceReportPositions does.
function Report(key: string, ts: number, port: number, entries: [string, number, number, number][]): Buffer {
    const parts = [Buffer.from([0x50]), Buffer.alloc(8), Buffer.alloc(2), Buffer.from([entries.length])];
    parts[1].writeBigUInt64BE(BigInt(ts));
    parts[2].writeUInt16BE(port);
    for (const [id, x, y, z] of entries) {
        const xyz = Buffer.alloc(12);
        xyz.writeFloatBE(x, 0); xyz.writeFloatBE(y, 4); xyz.writeFloatBE(z, 8);
        parts.push(Buffer.from([Buffer.byteLength(id)]), Buffer.from(id), xyz);
    }
    const body = Buffer.concat(parts);
    return Buffer.concat([body, crypto.createHmac("sha256", key).update(body).digest()]);
}

test("position reports need the gameserver key and are never replayed", () => {
    const r = Report("k1", 1000, 8777, [["a", 1, 2, 3]]);
    assert.deepEqual(ParsePositionReport(r, ["k0", "k1"])?.entries, [{ userId: "a", x: 1, y: 2, z: 3 }]);
    assert.equal(ParsePositionReport(r, ["other"]), undefined, "wrong key");
    assert.equal(ParsePositionReport(r, []), undefined, "no keys configured = proximity off");
    const tampered = Buffer.from(r); tampered[15] ^= 1;
    assert.equal(ParsePositionReport(tampered, ["k1"]), undefined, "tampered body");

    let now = 1000;
    const s = new VoiceRelayState({ validate: () => undefined, partyMembers: async () => [], serverKeys: () => ["k1"], now: () => now });
    assert.equal(s.report("10.0.0.1", ParsePositionReport(r, ["k1"])!), true);
    assert.equal(s.report("10.0.0.1", ParsePositionReport(r, ["k1"])!), false, "replay");
    now = 60000;
    assert.equal(s.report("10.0.0.1", ParsePositionReport(Report("k1", 2000, 8777, []), ["k1"])!), false, "stale timestamp");
});

test("proximity: only server-reported players on the same hub within range hear the speaker", async () => {
    let now = 10000;
    const users = ["a", "b", "c", "d", "e"];
    const s = new VoiceRelayState({
        validate: (t) => t, partyMembers: async (u) => (u === "a" || u === "e" ? ["a", "e"] : [u]), serverKeys: () => ["k"], now: () => now,
    });
    users.forEach((u, i) => s.hello("10.0.0.9", 5000 + i, u));
    const hub = (ts: number, e: [string, number, number, number][]) => s.report("10.0.0.2", ParsePositionReport(Report("k", ts, 8777, e), ["k"])!);
    hub(now, [["a", 0, 0, 0], ["b", HEAR_RADIUS - 1, 0, 0], ["c", HEAR_RADIUS + 1, 0, 0]]);
    // d is on another hub right next to a's coordinates; e is a's party member in a hunt (no position).
    s.report("10.0.0.3", ParsePositionReport(Report("k", now, 8777, [["d", 0, 0, 0]]), ["k"])!);

    const heard = async () => Object.fromEntries((await s.route("10.0.0.9", 5000, 50)).map((t) => [t.peer.userId, t.flags]));
    assert.deepEqual(await heard(), { b: 1, e: 2 }, "b near (positional), c too far, d other hub, e party");

    now += 2000;                                         // reports stopped: b drops out, party stays
    assert.deepEqual(await heard(), { e: 2 });
});

test("a client cannot get proximity voice without a hub report", async () => {
    const s = new VoiceRelayState({ validate: (t) => t, partyMembers: async (u) => [u], serverKeys: () => ["k"], now: () => 1 });
    s.hello("10.0.0.9", 1, "a"); s.hello("10.0.0.9", 2, "b");
    assert.deepEqual(await s.route("10.0.0.9", 1, 50), []);
});

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.AUTH_SIGNING_PRIVKEY_B64 = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_SIGNING_PUBKEY_B64 = Buffer.from(publicKey.export({ type: "spki", format: "pem" })).toString("base64");

test("voice tickets round-trip and reject tampering", () => {
    const t = SignVoiceTicket("user-a");
    assert.equal(ValidateVoiceTicket(t), "user-a");
    assert.equal(ValidateVoiceTicket(t.slice(0, -2) + "xx"), undefined);
    assert.equal(ValidateVoiceTicket("garbage"), undefined);
});

test("relay forwards a frame to party members only", async () => {
    const parties: Record<string, string[]> = { a: ["a", "b"], b: ["a", "b"], c: ["c"] };
    const relay = StartVoiceRelay(0, {
        validate: (t) => ({ ta: "a", tb: "b", tc: "c" } as Record<string, string>)[t],
        partyMembers: async (u) => parties[u] ?? [],
        serverKeys: () => [],
        now: () => Date.now(),
    });
    await once(relay, "listening");
    const port = relay.address().port;
    const clients = await Promise.all(["a", "b", "c"].map(async () => {
        const s = dgram.createSocket("udp4");
        s.bind(0, "127.0.0.1");
        await once(s, "listening");
        const got: Buffer[] = [];
        s.on("message", (m) => got.push(m));
        return { s, got };
    }));
    const send = (i: number, b: Buffer) => clients[i].s.send(b, port, "127.0.0.1");
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
        ["ta", "tb", "tc"].forEach((t, i) => send(i, Buffer.concat([Buffer.from("H"), Buffer.from(t)])));
        send(0, Buffer.from("Hbad-ticket"));                 // ignored, no second ack
        await wait(150);
        for (const c of clients) assert.deepEqual(c.got.map(String), ["A"]);

        send(0, Buffer.from([0x56, 0x00, 0x07, 1, 2, 3]));  // V seq=7 opus=010203 from a
        send(0, Buffer.concat([Buffer.from([0x56, 0, 1]), Buffer.alloc(1300)])); // oversize: dropped
        await wait(150);
        const toB = clients[1].got.slice(1);
        assert.equal(toB.length, 1);
        assert.equal(toB[0][0], 0x57);
        assert.equal(toB[0].readUInt32BE(1), SenderKey("a"));
        assert.deepEqual([...toB[0].subarray(5)], [0x00, 0x07, 2 /* party, no position */, 1, 2, 3]);
        assert.equal(clients[0].got.length, 1, "no echo to the sender");
        assert.equal(clients[2].got.length, 1, "nothing to another party");
    } finally {
        relay.close();
        for (const c of clients) c.s.close();
    }
});
