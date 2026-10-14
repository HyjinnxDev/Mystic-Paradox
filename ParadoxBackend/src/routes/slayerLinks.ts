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
import {
    Answer, Availability, AvailabilityIds, DeleteInvites, DeleteLink, Invite, InvitesList, LinksList, REWARD_GRACE_HOURS,
    RewardsGrant, SaveRewards, SlayerLinkReply, SlayerLinkResult, SlayerLinkRow, Status
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

async function Apply(Result: SlayerLinkResult) {
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
    Send(res, Status(await RowsOf([Me]), Me, Date.now()));
});

slayerLinksRouter.get("/slayerlink/invites", HasParadoxBackendAuth, async (req, res) => {
    const Me = Player(req, res); if (!Me) return;
    Send(res, InvitesList(await RowsOf([Me]), Me, Date.now()));
});

slayerLinksRouter.get("/slayerlink/links", HasParadoxBackendAuth, async (req, res) => {
    const Me = Player(req, res); if (!Me) return;
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
            await Apply(DeleteLink(await RowsOf([Owner]), Owner, { slot: E?.slot }, {}, Date.now()));
        }
        return res.status(200).json({});
    }
    const Me = Player(req, res); if (!Me) return;
    const Result = DeleteLink(await RowsOf([Me]), Me, req.body, req.query, Date.now());
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
