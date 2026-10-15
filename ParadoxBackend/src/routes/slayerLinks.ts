/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import crypto from "node:crypto";
import express from "express";
import { logger } from "../logger";
import { GetRepositories } from "../persistence";
import { GetMongoDb } from "../persistence/mongo/client";
import { Collections } from "../persistence/mongo/collections";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import { GetCharactersForUid } from "../controllers/character";
import { GetInventoryForUserIdAndCharacterId, RunInventoryTransaction } from "../controllers/inventory";
import {
    Answer, Availability, AvailabilityIds, DeleteInvites, DeleteLink, Invite, InvitesList, LINK_CROWN, LINK_TRACK_PREFIX,
    LinkPrize, LinksList, REWARD_GRACE_HOURS, RewardsGrant, SaveRewards, SettleLink, SlayerLinkReply, SlayerLinkResult,
    SlayerLinkRow, Status
} from "../slayerLinks";

// Slayer Links routes (social-prod.steelyard.ca/slayerlink/*). Rules and shapes: src/slayerLinks.ts.
// Every route acts as the bearer token's player; ids in the body/path only name the other player.
// ponytail: read-decide-write without a transaction; two players racing for the same slot can both win.
// Wrap in a Mongo session (GetUnitOfWork) if that ever shows up.
export const slayerLinksRouter = express.Router();

// Rows of these players. Old rows are removed by the purgeAt TTL index (persistence/mongo/indexes.ts).
async function RowsOf(ids: string[]): Promise<SlayerLinkRow[]> {
    const Db = await GetMongoDb();
    return await Db.collection<SlayerLinkRow>(Collections.SlayerLinks)
        .find({ $or: [{ senderId: { $in: ids } }, { targetId: { $in: ids } }] }).toArray();
}

async function FriendsOf(me: string): Promise<Set<string>> {
    const Edges = await GetRepositories().friendships.listForOwner(me);
    return new Set(Edges.filter((e) => e.status === "ACCEPTED").map((e) => e.otherId));
}

async function Apply(Result: Omit<SlayerLinkResult, "reply">) {
    const Db = await GetMongoDb();
    const Coll = Db.collection<SlayerLinkRow & { purgeAt: Date }>(Collections.SlayerLinks);
    for (const Row of Result.put ?? []) {
        const PurgeAt = Row.endsAt !== null ? Row.endsAt + REWARD_GRACE_HOURS * 60 * 60 * 1000 : Row.expiresAt;
        await Coll.replaceOne({ _id: Row._id }, { ...Row, purgeAt: new Date(PurgeAt) }, { upsert: true });
    }
    if (Result.remove) await Coll.deleteOne({ _id: Result.remove });
    // Same _id scheme as MongoProgressionTrackRepository ("userId::progressionId")
    for (const [UserId, TrackId] of Result.resetTracks ?? []) {
        await Db.collection(Collections.ProgressionTracks).deleteOne({ _id: `${UserId}::${TrackId}` as any });
    }
    logger.info(`slayerlink: ${Result.log}`);
}

const SlotOf = (Row: SlayerLinkRow, Id: string) => (Row.senderId === Id ? Row.senderSlot : Row.targetSlot ?? 0);
const LinkXp = async (Id: string, Slot: number) =>
    (await GetRepositories().progressionTracks.get(Id, `${LINK_TRACK_PREFIX}${Slot}`))?.progress ?? 0;

async function CharacterOf(Me: string): Promise<string | undefined> {
    const Characters: any = await GetCharactersForUid(Me);
    const Character = Array.isArray(Characters) ? Characters[0] : undefined;
    return Character?.id ?? Character?.characterId;
}

async function OwnsCrown(Me: string): Promise<boolean> {
    const CharacterId = await CharacterOf(Me);
    if (!CharacterId) return false;
    const Inventory: any = await GetInventoryForUserIdAndCharacterId(Me, CharacterId);
    const Items = (Raw: unknown): any[] => { try { return typeof Raw === "string" ? JSON.parse(Raw) : Array.isArray(Raw) ? Raw : []; } catch { return []; } };
    return [...Items(Inventory?.stackedItems), ...Items(Inventory?.instancedItems)].some((I) => I?.catalogId === LINK_CROWN);
}

// One transaction per link and player; the id is stable so a retry replays instead of granting twice.
async function GrantPrizes(Me: string, Row: SlayerLinkRow, Prizes: LinkPrize[]): Promise<boolean> {
    try {
        const CharacterId = await CharacterOf(Me);
        if (!CharacterId) { logger.warn(`slayerlink: reward grant for=${Me} id=${Row._id} waits: no character`); return false; }
        const TransactionId = crypto.createHash("sha256").update(`slayerlink-reward:${Row._id}:${Me}`).digest("hex").slice(0, 32).toUpperCase();
        const Stacked = Prizes.map((P) => ({ catalogId: P.catalog_id, quantity: P.quantity }));
        return !!await RunInventoryTransaction(Me, CharacterId, TransactionId, [], Stacked, [], [], []);
    } catch (Err) {
        logger.error(`slayerlink: reward grant for=${Me} id=${Row._id} failed, retried on the next read: ${String(Err)}`);
        return false;
    }
}

// Before answering a read of my links: draw missing pools, unlock reached chests, grant ended links (SettleLink).
async function Settle(Me: string) {
    const Now = Date.now();
    for (const Row of await RowsOf([Me])) {
        if (Row.status !== "LINKED" || (Row.endsAt ?? 0) + REWARD_GRACE_HOURS * 60 * 60 * 1000 <= Now || Row.rewardsGranted?.includes(Me)) continue;
        const Xp = await LinkXp(Me, SlotOf(Row, Me));
        const Skip = new Set<string>(!Row.prizePools?.[Me] && await OwnsCrown(Me) ? [LINK_CROWN] : []);
        let { put, grant } = SettleLink(Row, Me, Xp, Now, Math.random, Skip);
        let Log = `settle for=${Me} id=${Row._id} xp=${Xp}`;
        if (grant && (grant.length === 0 || await GrantPrizes(Me, Row, grant))) {
            put = { ...(put ?? Row), rewardsGranted: [...(Row.rewardsGranted ?? []), Me] };
            Log += ` -> granted [${grant.map((P) => `${P.catalog_id}x${P.quantity}@${P.received_for_level}`).join(",")}]`;
        }
        if (put) await Apply({ put: [put], log: Log });
    }
}

// Links that earned XP (on either side) cannot be broken until their week ends.
async function LockedLinks(Rows: SlayerLinkRow[]): Promise<Set<string>> {
    const Locked = new Set<string>();
    for (const Row of Rows) {
        if (Row.status !== "LINKED") continue;
        if (await LinkXp(Row.senderId, Row.senderSlot) > 0 || (Row.targetSlot && await LinkXp(Row.targetId, Row.targetSlot) > 0)) Locked.add(Row._id);
    }
    return Locked;
}

function Send(res: express.Response, Reply: SlayerLinkReply) {
    res.status(Reply.status).json(Reply.body);
}

// The client always sends its own bearer; a game server's key alone is not a player.
function Player(req: any, res: express.Response): string | undefined {
    const Me = req.AuthData?.userId;
    if (typeof Me !== "string" || req.AuthData?.IsGameserver) {
        res.status(403).send();
        return undefined;
    }
    return Me;
}

slayerLinksRouter.get("/slayerlink/status_good", HasParadoxBackendAuth, async (req, res) => {
    const Me = Player(req, res); if (!Me) return;
    await Settle(Me);
    Send(res, Status(await RowsOf([Me]), Me, Date.now()));
});

slayerLinksRouter.get("/slayerlink/invites", HasParadoxBackendAuth, async (req, res) => {
    const Me = Player(req, res); if (!Me) return;
    Send(res, InvitesList(await RowsOf([Me]), Me, Date.now()));
});

slayerLinksRouter.get("/slayerlink/links", HasParadoxBackendAuth, async (req, res) => {
    const Me = Player(req, res); if (!Me) return;
    await Settle(Me);
    Send(res, LinksList(await RowsOf([Me]), Me, Date.now()));
});

slayerLinksRouter.put("/slayerlink/invite", HasParadoxBackendAuth, async (req, res) => {
    const Me = Player(req, res); if (!Me) return;
    const Ids = typeof req.body?.account_id === "string" ? [Me, req.body.account_id] : [Me];
    const Result = Invite(await RowsOf(Ids), Me, await FriendsOf(Me), req.body, Date.now(), crypto.randomUUID());
    await Apply(Result);
    Send(res, Result.reply);
});

slayerLinksRouter.post("/slayerlink/invite", HasParadoxBackendAuth, async (req, res) => {
    const Me = Player(req, res); if (!Me) return;
    const Ids = typeof req.body?.account_id === "string" ? [Me, req.body.account_id] : [Me];
    const Result = Answer(await RowsOf(Ids), Me, await FriendsOf(Me), req.body, Date.now());
    await Apply(Result);
    Send(res, Result.reply);
});

slayerLinksRouter.delete("/slayerlink/invites/:accountId", HasParadoxBackendAuth, async (req, res) => {
    const Me = Player(req, res); if (!Me) return;
    const Result = DeleteInvites(await RowsOf([Me]), Me, req.params.accountId, Date.now());
    await Apply(Result);
    Send(res, Result.reply);
});

// Unlink comes from the game server: {links:[{account_id, slot, delete_pair}]}, account_id = the link's owner.
// A link is one row shared by both players, so removing it always unlinks the pair (delete_pair is not needed).
slayerLinksRouter.delete("/slayerlink/links", HasParadoxBackendAuth, async (req: any, res) => {
    if (req.AuthData?.IsGameserver) {
        const Entries = req.body?.links;
        if (!Array.isArray(Entries) || Entries.length === 0 || Entries.length > 3) return res.status(400).send();
        for (const E of Entries) {
            const Owner = RewardOwner(req, res, E?.account_id); if (!Owner) return;
            const Rows = await RowsOf([Owner]);
            const Result = DeleteLink(Rows, Owner, { slot: E?.slot }, {}, Date.now(), await LockedLinks(Rows));
            await Apply(Result);
            if (Result.reply.status !== 200) return Send(res, Result.reply);
        }
        return res.status(200).json({});
    }
    const Me = Player(req, res); if (!Me) return;
    const Rows = await RowsOf([Me]);
    const Result = DeleteLink(Rows, Me, req.body, req.query, Date.now(), await LockedLinks(Rows));
    await Apply(Result);
    Send(res, Result.reply);
});

// The reward routes come from the game server's link component: a game server names the player in account_id,
// a player bearer acts for itself.
function RewardOwner(req: any, res: express.Response, AccountId: unknown): string | undefined {
    const Owner = req.AuthData?.IsGameserver ? AccountId : req.AuthData?.userId;
    if (typeof Owner !== "string" || Owner.length === 0 || Owner.length > 128) {
        res.status(req.AuthData?.IsGameserver ? 400 : 403).send();
        return undefined;
    }
    return Owner;
}

slayerLinksRouter.put("/slayerlink/links/rewards", HasParadoxBackendAuth, async (req: any, res) => {
    const Owner = RewardOwner(req, res, req.body?.account_id); if (!Owner) return;
    const Result = SaveRewards(await RowsOf([Owner]), Owner, req.body, Date.now());
    await Apply(Result);
    Send(res, Result.reply);
});

slayerLinksRouter.get("/slayerlink/links/rewards/:accountId/:slot", HasParadoxBackendAuth, async (req: any, res) => {
    const Owner = RewardOwner(req, res, req.params.accountId); if (!Owner) return;
    const Result = RewardsGrant(await RowsOf([Owner]), Owner, req.params.slot, Date.now());
    await Apply(Result);
    Send(res, Result.reply);
});

slayerLinksRouter.post("/slayerlink/availability", HasParadoxBackendAuth, async (req, res) => {
    const Me = Player(req, res); if (!Me) return;
    const Ids = AvailabilityIds(req.body);
    Send(res, Availability(await RowsOf([Me, ...Ids]), Me, await FriendsOf(Me), Ids, Date.now()));
});
