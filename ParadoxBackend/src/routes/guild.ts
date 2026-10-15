/*
 * Original work Copyright (C) 2026 gwog :3 (SyST3MDeV/Undaunted)
 * Modified work Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * You may obtain a copy of the License at the root of this repository.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import { Router } from "express";
import { HasParadoxBackendAuth } from "../middleware/HasParadoxBackendAuth";
import {
    AcceptGuildInvite, ChangeGuildRank, CreateGuild, DeclineGuildInvite, DisbandGuild, GetOwnGuild, GuildReply, InviteToGuild,
    KickGuildMember, LeaveGuild, ListOwnGuildInvites, ValidateGuildCreate
} from "../controllers/guild";

// Guild routes (guild-prod.steelyard.ca), the *_v2 endpoint keys in the 1.14.7 exe. Rules and reply shapes:
// controllers/guild.ts. Every player route acts as the bearer token's own account; ids in the URL only name
// the other player, the invite or the guild. Order matters: DELETE /guild/player[/:accountId] before
// DELETE /guild/:guildId.

export const guildRouter = Router();

function Send(res: any, Reply: GuildReply){
    res.status(Reply.Status);
    if(Reply.Body === undefined) res.send();
    else res.json(Reply.Body);
}

// A player's own token. Game-server calls fall back to a configured account in HasParadoxBackendAuth, so they
// must never act as a player here.
function PlayerOnly(req: any, res: any, next: any){
    const UserId = req.AuthData?.userId;
    if(req.AuthData?.IsGameserver || typeof UserId !== "string" || UserId.length === 0){
        res.status(403).send();
        return;
    }
    next();
}

// Read at login, each world load and after every guild action
guildRouter.get("/guild/invite/player", HasParadoxBackendAuth, PlayerOnly, async (req: any, res) => {
    Send(res, await ListOwnGuildInvites(req.AuthData.userId));
});

// The caller's guild; 204 when there is none
guildRouter.get("/guild", HasParadoxBackendAuth, PlayerOnly, async (req: any, res) => {
    Send(res, await GetOwnGuild(req.AuthData.userId));
});

// {leader_account_id, name, nameplate}, sent while the player types in CREATE A GUILD
guildRouter.post("/guild/validate", HasParadoxBackendAuth, PlayerOnly, async (req: any, res) => {
    Send(res, await ValidateGuildCreate(req.AuthData.userId, req.body?.name, req.body?.nameplate));
});

// Create: from the Ramsgate server (game-server key, leader from the body) or from the client itself (its token is the leader)
guildRouter.post("/guild", HasParadoxBackendAuth, async (req: any, res) => {
    const FromGameServer = req.AuthData?.IsGameserver === true;
    const Leader = FromGameServer ? req.body?.leader_account_id : req.AuthData?.userId;
    Send(res, await CreateGuild(Leader, FromGameServer, req.body?.name, req.body?.nameplate));
});

guildRouter.delete("/guild/player", HasParadoxBackendAuth, PlayerOnly, async (req: any, res) => {
    Send(res, await LeaveGuild(req.AuthData.userId));
});

guildRouter.delete("/guild/player/:accountId", HasParadoxBackendAuth, PlayerOnly, async (req: any, res) => {
    Send(res, await KickGuildMember(req.AuthData.userId, req.params.accountId));
});

guildRouter.put("/guild/invite/:accountId", HasParadoxBackendAuth, PlayerOnly, async (req: any, res) => {
    Send(res, await InviteToGuild(req.AuthData.userId, req.params.accountId));
});

guildRouter.post("/guild/invite/accept/:inviteId", HasParadoxBackendAuth, PlayerOnly, async (req: any, res) => {
    Send(res, await AcceptGuildInvite(req.AuthData.userId, req.params.inviteId));
});

guildRouter.delete("/guild/invite/:inviteId", HasParadoxBackendAuth, PlayerOnly, async (req: any, res) => {
    Send(res, await DeclineGuildInvite(req.AuthData.userId, req.params.inviteId));
});

// member | officer | leader
guildRouter.put("/guild/rank/:accountId/:rank", HasParadoxBackendAuth, PlayerOnly, async (req: any, res) => {
    Send(res, await ChangeGuildRank(req.AuthData.userId, req.params.accountId, req.params.rank));
});

// Leader only. Last: it would otherwise take DELETE /guild/player.
guildRouter.delete("/guild/:guildId", HasParadoxBackendAuth, PlayerOnly, async (req: any, res) => {
    Send(res, await DisbandGuild(req.AuthData.userId, req.params.guildId));
});
