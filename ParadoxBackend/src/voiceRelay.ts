/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Voice relay. 1.14.7's own voice (EOS RTC) cannot work against a private server, so the client
// runtime (ParadoxRuntime/Voice.cpp) captures the mic, encodes Opus and sends it here over UDP; this
// forwards each frame to the sender's party members (anywhere) and, on a hub server (Ramsgate/dojo), to
// every player within HEAR_RADIUS of the speaker.
//
// Proximity is decided HERE, from positions the hub server itself reports ('P', HMAC-signed with the
// gameserver API key). A client never supplies its own room or position, so it cannot listen in on a
// room it is not in or on a speaker it is not standing near. No fresh report = no proximity voice.
//
// Wire format (all integers big-endian, floats IEEE-754 big-endian, positions in UE units = cm):
//   client -> relay  'H' ticket(utf8)                    hello/keepalive every 5 s; answered with 'A'
//   client -> relay  'V' seq:u16 opus                    one 20 ms frame
//   relay -> client  'A'                                 hello accepted
//   relay -> client  'W' sender:u32 seq:u16 flags:u8 [x:f32 y:f32 z:f32] opus
//                    flags bit0 = position follows (the speaker's server-reported location), bit1 = party member
//   server -> relay  'P' ts:u64 port:u16 n:u8 { len:u8 accountId(utf8) x:f32 y:f32 z:f32 }*n hmac:32
//                    hmac = HMAC-SHA256(gameserver key, every byte before it); ts = ms epoch, strictly
//                    increasing per server; the room is the reporting server's address + game port.
//
// ponytail: plain UDP, no encryption (Tailscale encrypts the path).

import dgram from "node:dgram";
import crypto from "node:crypto";
import jwt, { JwtPayload } from "jsonwebtoken";
import { logger } from "./logger";
import { GetPartyForPlayer } from "./controllers/party";
import { ParseConfiguredGameserverAPIKeys } from "./controllers/apikeys";

const VOICE_AUDIENCE = "mysticparadox-voice";
const ISSUER = "paradox-backend";
const TICKET_TTL = "24h";
const MAX_PACKET = 1200;
const MAX_PACKETS_PER_SECOND = 60;
const PEER_TTL_MS = 15000;
const PARTY_CACHE_MS = 2000;
export const HEAR_RADIUS = 4000;           // 40 m; the client fades to silence at the same distance
const POSITION_TTL_MS = 1500;               // hubs report every 200 ms; older = the player left
const REPORT_MAX_SKEW_MS = 10000;
const FLAG_POSITION = 1, FLAG_PARTY = 2;

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
interface Position { room: string; x: number; y: number; z: number; at: number }
export interface Target { peer: Peer; flags: number; pos?: Position }
export interface PositionReport { ts: number; port: number; entries: { userId: string; x: number; y: number; z: number }[] }

export interface RelayDeps {
    validate(ticket: string): string | undefined;
    partyMembers(userId: string): Promise<string[]>;
    serverKeys(): string[];
    now(): number;
}

/** A hub's signed position report, or undefined when it is malformed or no key signed it. */
export function ParsePositionReport(msg: Buffer, keys: string[]): PositionReport | undefined {
    if (msg.length < 1 + 8 + 2 + 1 + 32 || msg[0] !== 0x50 /* P */) return undefined;
    const body = msg.subarray(0, msg.length - 32), mac = msg.subarray(msg.length - 32);
    if (!keys.some((k) => crypto.timingSafeEqual(crypto.createHmac("sha256", k).update(body).digest(), mac))) return undefined;
    const ts = Number(body.readBigUInt64BE(1)), port = body.readUInt16BE(9), n = body[11];
    const entries: PositionReport["entries"] = [];
    let o = 12;
    for (let i = 0; i < n; i++) {
        if (o + 1 > body.length) return undefined;
        const len = body[o++];
        if (len === 0 || o + len + 12 > body.length) return undefined;
        const userId = body.toString("utf8", o, o + len);
        o += len;
        const x = body.readFloatBE(o), y = body.readFloatBE(o + 4), z = body.readFloatBE(o + 8);
        o += 12;
        if (![x, y, z].every(Number.isFinite)) return undefined;
        entries.push({ userId, x, y, z });
    }
    return o === body.length ? { ts, port, entries } : undefined;
}

// Live peers keyed by "address:port", plus each user's current address and server-reported position.
export class VoiceRelayState {
    readonly peers = new Map<string, Peer>();
    private readonly byUser = new Map<string, string>();
    private readonly partyCache = new Map<string, { members: string[]; at: number }>();
    private readonly positions = new Map<string, Position>();
    private readonly roomTs = new Map<string, number>();
    constructor(private readonly deps: RelayDeps) {}

    /** Applies a verified hub report from address. False when it is stale or replayed. */
    report(address: string, r: PositionReport): boolean {
        const now = this.deps.now();
        const room = `${address}:${r.port}`;
        if (Math.abs(r.ts - now) > REPORT_MAX_SKEW_MS || r.ts <= (this.roomTs.get(room) ?? 0)) return false;
        this.roomTs.set(room, r.ts);
        for (const e of r.entries) this.positions.set(e.userId, { room, x: e.x, y: e.y, z: e.z, at: now });
        return true;
    }

    private position(userId: string, now: number): Position | undefined {
        const p = this.positions.get(userId);
        if (p && now - p.at > POSITION_TTL_MS) { this.positions.delete(userId); return undefined; }
        return p;
    }

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
    // Party members hear the speaker anywhere; other players only on the same hub within HEAR_RADIUS, both
    // positions server-reported. The speaker's position goes along whenever both share a room, for panning.
    async route(address: string, port: number, size: number): Promise<Target[]> {
        if (size > MAX_PACKET) return [];
        const now = this.deps.now();
        this.expire(now);
        const from = this.peers.get(`${address}:${port}`);
        if (!from) return [];
        if (now - from.windowStart >= 1000) { from.windowStart = now; from.windowCount = 0; }
        if (++from.windowCount > MAX_PACKETS_PER_SECOND) return [];
        const party = new Set(await this.members(from.userId, now));
        const at = this.position(from.userId, now);
        const out: Target[] = [];
        for (const peer of this.peers.values()) {
            if (peer.userId === from.userId || this.byUser.get(peer.userId) !== `${peer.address}:${peer.port}`) continue;
            const theirs = at && this.position(peer.userId, now);
            const sameRoom = !!at && !!theirs && theirs.room === at.room;
            const near = sameRoom && Math.hypot(theirs.x - at.x, theirs.y - at.y, theirs.z - at.z) <= HEAR_RADIUS;
            const inParty = party.has(peer.userId);
            if (!inParty && !near) continue;
            out.push({ peer, flags: (sameRoom ? FLAG_POSITION : 0) | (inParty ? FLAG_PARTY : 0), pos: sameRoom ? at : undefined });
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
    const seenRooms = new Set<string>();
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
                const key = SenderKey(from.userId);
                for (const t of targets) {
                    const head = Buffer.alloc(t.pos ? 20 : 8);
                    head[0] = 0x57; /* W */
                    head.writeUInt32BE(key, 1);
                    msg.copy(head, 5, 1, 3);                     // seq
                    head[7] = t.flags;
                    if (t.pos) { head.writeFloatBE(t.pos.x, 8); head.writeFloatBE(t.pos.y, 12); head.writeFloatBE(t.pos.z, 16); }
                    socket.send(Buffer.concat([head, msg.subarray(3)]), t.peer.port, t.peer.address);
                }
            }).catch((e) => logger.warn(`[Voice] route failed: ${e}`));
        } else if (type === 0x50 /* P */) {
            if (msg.length > MAX_PACKET) return;
            const r = ParsePositionReport(msg, deps.serverKeys());
            if (!r) {
                if (!seenRooms.has(`bad:${rinfo.address}`)) logger.warn(`[Voice] rejected position report from ${rinfo.address} (bad signature or format; logged once)`);
                seenRooms.add(`bad:${rinfo.address}`);
                return;
            }
            const room = `${rinfo.address}:${r.port}`;
            if (state.report(rinfo.address, r) && !seenRooms.has(room)) {
                seenRooms.add(room);
                logger.info(`[Voice] proximity reports from hub ${room} (${r.entries.length} player(s): ${r.entries.map((e) => e.userId).join(",")})`);
            }
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
    serverKeys: () => ParseConfiguredGameserverAPIKeys(process.env.GAMESERVER_API_KEYS),
    now: () => Date.now(),
};
