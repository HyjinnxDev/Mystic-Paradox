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
import { SenderKey, SignVoiceTicket, StartVoiceRelay, ValidateVoiceTicket } from "./voiceRelay";

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
        assert.equal(toB[0][0], 0x56);
        assert.equal(toB[0].readUInt32BE(1), SenderKey("a"));
        assert.deepEqual([...toB[0].subarray(5)], [0x00, 0x07, 1, 2, 3]);
        assert.equal(clients[0].got.length, 1, "no echo to the sender");
        assert.equal(clients[2].got.length, 1, "nothing to another party");
    } finally {
        relay.close();
        for (const c of clients) c.s.close();
    }
});
