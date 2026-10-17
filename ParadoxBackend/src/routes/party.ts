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
import { logger } from "../logger";
import { GetDisplayNameForUserId } from "../controllers/login";
import {
    GetOrCreateParty,
    InviteToParty,
    GetInvitesForPlayer,
    AcceptInvite,
    LeaveParty,
    KickMember,
    PromoteMember,
    GetPartyForPlayer
} from "../controllers/party";
import { FindLateJoinOffer, GetPartyInstance, GetPlayerCandidate, GrantLateJoin } from "../controllers/matchmaking";
import { sessionRegistry } from "../realtime/SessionRegistry";
import { ValidateVoiceTicket } from "../voiceRelay";

// mm2-prod party service. Shapes captured in
// DauntlessEndpointDocumentation/Matchmaking/{GetParty,Party/*}.md. The response contract is
// unchanged, but Mongo now owns membership/revisions and a transactional outbox publishes changes.
export const partyRouter = Router();

const PLATFORM = "win";

// POST /party — own party state (implicitly creates a solo party on first call). Reflects the
// party's shared matchmaking state so members polling this follow the leader into the hunt.
partyRouter.post("/party", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    const BuildId: string = req.body?.buildId ?? "";

    const Party = await GetOrCreateParty(UserId, BuildId);
    res.setHeader("X-Mystic-Party-Revision", Party.revision.toString());
    const Instance = await GetPartyInstance(Party.partyId);
    const InHunt = Instance != undefined;
    // PartyInstance carries the shared destination/session. MatchmakingResultMap carries this
    // member's independently consumable candidate. Prefer the latter so followers do not receive
    // the leader's already-consumed candidate while still reporting party-wide state below.
    const Candidate = (await GetPlayerCandidate(UserId)) ?? Instance;

    const PlayerStates = await Promise.all(Party.members.map(async (Member) => ({
        consoleSessionId: null,
        displayName: await GetDisplayNameForUserId(Member),
        isMemberOfCandidate: InHunt ? true : Member === Party.leaderPlayerId,
        platform: PLATFORM,
        playerId: Member
    })));

    res.status(200).json({
        candidateId: Candidate?.CandidateId ?? null,
        candidateState: Instance ? (Instance.Ready ? "IN_PROGRESS" : "MATCHING") : "QUEUED_FOR_START",
        gauntletLevel: null,
        leaderPlayerId: Party.leaderPlayerId,
        partyId: Party.partyId,
        playerHuntId: Instance?.HuntId ?? null,
        playerStates: PlayerStates
    });
});

// Join-in-progress, for the client runtime's Join / Wait popup. The runtime has no game bearer token, so it
// authenticates with the launcher's voice ticket (same identity the voice relay trusts).
function TicketUserId(req: any): string | undefined {
    const Ticket = req.headers["x-mystic-ticket"];
    return typeof Ticket === "string" && Ticket.length > 0 ? ValidateVoiceTicket(Ticket) : undefined;
}

async function LateJoinContext(UserId: string) {
    const Party = await GetPartyForPlayer(UserId);
    if (Party == undefined || Party.members.length < 2) return undefined;
    const Offer = await FindLateJoinOffer(UserId, Party.members, (Id) => sessionRegistry.isOnline(Id));
    return Offer ? { Party, Offer } : undefined;
}

// GET /mystic/party/hunt-offer -> { offer: null } or { offer: { memberName, huntId, hpPct, players, blocked } }
partyRouter.get("/mystic/party/hunt-offer", async (req: any, res) => {
    const UserId = TicketUserId(req);
    if (UserId == undefined) { res.status(401).json({}); return; }
    const Context = await LateJoinContext(UserId);
    if (Context == undefined) { res.status(200).json({ offer: null }); return; }
    const { Offer } = Context;
    res.status(200).json({
        offer: {
            memberName: await GetDisplayNameForUserId(Offer.MemberId),
            huntId: Offer.Result.HuntId,
            hpPct: Offer.State?.hpPct ?? -1,
            players: Offer.State?.players ?? 0,
            blocked: Offer.Blocked ?? null
        }
    });
});

// POST /mystic/party/join-hunt -> 200 { ok: true } or 409 { reason }
partyRouter.post("/mystic/party/join-hunt", async (req: any, res) => {
    const UserId = TicketUserId(req);
    if (UserId == undefined) { res.status(401).json({}); return; }
    const Context = await LateJoinContext(UserId);
    const Reason = Context == undefined ? "NO_HUNT" : Context.Offer.Blocked;
    if (Reason != undefined) {
        logger.info(`[LateJoin] ${UserId} refused: ${Reason}`);
        res.status(409).json({ reason: Reason });
        return;
    }
    GrantLateJoin(UserId, Context!.Party.partyId, Context!.Offer);
    res.status(200).json({ ok: true });
});

// PUT /party/invite — invite a player to my party (recipientPlayerId in body).
partyRouter.put("/party/invite", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    const RecipientId: unknown = req.body?.recipientPlayerId;
    const BuildId: string = req.body?.buildId ?? "";

    if (typeof RecipientId === "string" && RecipientId.length > 0) {
        const SenderName = await GetDisplayNameForUserId(UserId);
        await InviteToParty(UserId, RecipientId, BuildId, SenderName, PLATFORM);
        logger.info(`${UserId} invited ${RecipientId} to their party`);
    }

    res.status(200).json({});
});

// GET /party/invites — my incoming invites.
partyRouter.get("/party/invites", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    const Invitations = (await GetInvitesForPlayer(UserId)).map((Invite) => ({
        partyId: Invite.partyId,
        recipientPlayerId: UserId,
        sendingDisplayName: Invite.sendingDisplayName,
        sendingPlatform: Invite.sendingPlatform,
        sendingPlayerId: Invite.sendingPlayerId
    }));

    res.status(200).json({ invitations: Invitations });
});

// PUT /party/invite/accept/:inviterId — accept an invite, joining the inviter's party.
partyRouter.put("/party/invite/accept/:inviterId", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    const InviterId: string = req.params.inviterId;
    const BuildId: string = req.body?.buildId ?? "";

    await AcceptInvite(UserId, InviterId, BuildId);
    logger.info(`${UserId} accepted party invite from ${InviterId}`);

    res.status(200).json({});
});

// DELETE /party/member — leave my party.
partyRouter.delete("/party/member", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    await LeaveParty(UserId);
    logger.info(`${UserId} left their party`);
    res.status(200).json({});
});

// DELETE /party/member/:targetId — kick a member.
partyRouter.delete("/party/member/:targetId", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    await KickMember(UserId, req.params.targetId);
    logger.info(`${UserId} kicked ${req.params.targetId} from the party`);
    res.status(200).json({});
});

// PUT /party/member/promote/:targetId — promote a member to leader.
partyRouter.put("/party/member/promote/:targetId", HasParadoxBackendAuth, async (req: any, res) => {
    const UserId: string = req.AuthData.userId;
    await PromoteMember(UserId, req.params.targetId);
    logger.info(`${UserId} promoted ${req.params.targetId} to party leader`);
    res.status(200).json({});
});
