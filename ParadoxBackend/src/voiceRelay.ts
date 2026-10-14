/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Party voice relay. 1.14.7's own voice (EOS RTC) cannot work against a private server, so the client
// runtime (ParadoxRuntime/Voice.cpp) captures the mic, encodes Opus and sends it here over UDP; this
// forwards each frame to the sender's party members.
//
// Wire format (all integers big-endian):
//   client -> relay  'H' ticket(utf8)            hello/keepalive every 5 s; answered with 'A'
//   client -> relay  'V' seq:u16 opus            one 20 ms frame
//   relay -> client  'A'                         hello accepted
//   relay -> client  'V' sender:u32 seq:u16 opus a party member's frame
//
// ponytail: plain UDP, no encryption (Tailscale encrypts the path); routing is party-only. For proximity,
// add the speaker's position to 'V' and attenuate by distance on the receiving client.

import dgram from "node:dgram";
import crypto from "node:crypto";
import jwt, { JwtPayload } from "jsonwebtoken";
import { logger } from "./logger";
import { GetPartyForPlayer } from "./controllers/party";

const VOICE_AUDIENCE = "mysticparadox-voice";
const ISSUER = "paradox-backend";
const TICKET_TTL = "24h";
const MAX_PACKET = 1200;
const MAX_PACKETS_PER_SECOND = 60;
const PEER_TTL_MS = 15000;
const PARTY_CACHE_MS = 2000;

const Key = (Name: string) => Buffer.from(process.env[Name]!, "base64").toString("utf-8");

export function SignVoiceTicket(userId: string): string {
    return jwt.sign({ userId }, Key("AUTH_SIGNING_PRIVKEY_B64"), { algorithm: "RS256", expiresIn: TICKET_TTL, issuer: ISSUER, audience: VOICE_AUDIENCE });
}

/** The ticket's userId, or undefined when the ticket is bad or expired. */
export function ValidateVoiceTicket(ticket: string): string | undefined {
    try {
        const P = jwt.verify(ticket, Key("AUTH_SIGNING_PUBKEY_B64"), { algorithms: ["RS256"], issuer: ISSUER, audience: VOICE_AUDIENCE }) as JwtPayload;
        return typeof P.userId === "string" && P.userId.length > 0 ? P.userId : undefined;
    } catch {
        return undefined;
    }
}

export const VoicePort = () => Number(process.env.VOICE_UDP_PORT?.trim() || "8791");

/** Stable 32-bit id a receiver keys its jitter buffer on (the userId itself is not sent). */
export const SenderKey = (userId: string) => crypto.createHash("sha256").update(userId).digest().readUInt32BE(0);

interface Peer { userId: string; address: string; port: number; lastSeen: number; windowStart: number; windowCount: number }

export interface RelayDeps {
    validate(ticket: string): string | undefined;
    partyMembers(userId: string): Promise<string[]>;
    now(): number;
}

// Live peers keyed by "address:port", plus each user's current address.
export class VoiceRelayState {
    readonly peers = new Map<string, Peer>();
    private readonly byUser = new Map<string, string>();
    private readonly partyCache = new Map<string, { members: string[]; at: number }>();
    constructor(private readonly deps: RelayDeps) {}

    hello(address: string, port: number, ticket: string): boolean {
        const userId = this.deps.validate(ticket);
        if (!userId) return false;
        const id = `${address}:${port}`;
        const old = this.byUser.get(userId);
        if (old && old !== id) this.peers.delete(old);           // the user moved (new NAT mapping / relaunch)
        const now = this.deps.now();
        const existing = this.peers.get(id);
        this.peers.set(id, existing && existing.userId === userId
            ? { ...existing, lastSeen: now }
            : { userId, address, port, lastSeen: now, windowStart: now, windowCount: 0 });
        this.byUser.set(userId, id);
        return true;
    }

    /** Where one voice frame from address:port goes; empty when it must be dropped. */
    async route(address: string, port: number, size: number): Promise<Peer[]> {
        if (size > MAX_PACKET) return [];
        const now = this.deps.now();
        this.expire(now);
        const from = this.peers.get(`${address}:${port}`);
        if (!from) return [];
        if (now - from.windowStart >= 1000) { from.windowStart = now; from.windowCount = 0; }
        if (++from.windowCount > MAX_PACKETS_PER_SECOND) return [];
        const members = await this.members(from.userId, now);
        const out: Peer[] = [];
        for (const m of members) {
            if (m === from.userId) continue;
            const id = this.byUser.get(m);
            const peer = id ? this.peers.get(id) : undefined;
            if (peer) out.push(peer);
        }
        return out;
    }

    private async members(userId: string, now: number): Promise<string[]> {
        const c = this.partyCache.get(userId);
        if (c && now - c.at < PARTY_CACHE_MS) return c.members;
        const members = await this.deps.partyMembers(userId);
        this.partyCache.set(userId, { members, at: now });
        return members;
    }

    private expire(now: number): void {
        for (const [id, p] of this.peers) {
            if (now - p.lastSeen > PEER_TTL_MS) {
                this.peers.delete(id);
                if (this.byUser.get(p.userId) === id) this.byUser.delete(p.userId);
            }
        }
    }
}

export function StartVoiceRelay(port: number, deps: RelayDeps): dgram.Socket {
    const state = new VoiceRelayState(deps);
    const socket = dgram.createSocket("udp4");
    socket.on("message", (msg, rinfo) => {
        if (msg.length < 1) return;
        const type = msg[0];
        if (type === 0x48 /* H */) {
            if (msg.length > MAX_PACKET) return;
            const isNew = !state.peers.has(`${rinfo.address}:${rinfo.port}`);
            if (state.hello(rinfo.address, rinfo.port, msg.subarray(1).toString("utf8"))) {
                if (isNew) logger.info(`[Voice] hello user=${state.peers.get(`${rinfo.address}:${rinfo.port}`)!.userId} from ${rinfo.address}:${rinfo.port}`);
                socket.send(Buffer.from("A"), rinfo.port, rinfo.address);
            }
        } else if (type === 0x56 /* V */ && msg.length > 3) {
            state.route(rinfo.address, rinfo.port, msg.length).then((targets) => {
                if (targets.length === 0) return;
                const from = state.peers.get(`${rinfo.address}:${rinfo.port}`)!;
                const out = Buffer.alloc(msg.length + 4);
                out[0] = 0x56;
                out.writeUInt32BE(SenderKey(from.userId), 1);
                msg.copy(out, 5, 1);
                for (const t of targets) socket.send(out, t.port, t.address);
            }).catch((e) => logger.warn(`[Voice] route failed: ${e}`));
        }
    });
    socket.on("error", (e) => logger.warn(`[Voice] relay socket error: ${e}`));
    socket.bind(port, () => logger.info(`[Voice] party voice relay on UDP ${port}`));
    return socket;
}

// Users an admin banned/disabled. Their ticket stays valid up to 24 h, so hellos are refused
// here and the peer expires within PEER_TTL_MS. ponytail: in-memory, a backend restart forgets
// it until the old ticket expires; check account eligibility in validate if that matters.
const VoiceBlockedUntil = new Map<string, number>();

export function SetVoiceBlocked(userId: string, untilMs: number | undefined): void {
    if (untilMs == undefined) VoiceBlockedUntil.delete(userId);
    else VoiceBlockedUntil.set(userId, untilMs);
}

export const DefaultRelayDeps: RelayDeps = {
    validate: (ticket) => {
        const userId = ValidateVoiceTicket(ticket);
        return userId && (VoiceBlockedUntil.get(userId) ?? 0) <= Date.now() ? userId : undefined;
    },
    partyMembers: async (userId) => (await GetPartyForPlayer(userId))?.members ?? [],
    now: () => Date.now(),
};
