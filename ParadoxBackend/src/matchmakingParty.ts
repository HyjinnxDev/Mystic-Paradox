/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Party-aware routing for POST /matchmaking (routes/matchmaking.ts) has two contracts:
// - ISLAND requests carry the partyId of the party the client is actively travelling with. It must match the
//   authoritative party, and only members with a live XMPP session go along. A stale server-side party (for
//   example after the other client disconnected) can then never turn "Private Hunt / solo" into a two-player
//   server whose airship waits forever.
// - CITY/ReturnToRamsgate requests omit partyId in the captured 1.12 protocol, so the authoritative party is
//   kept and returning members still fan out to the shared Ramsgate.

export type MatchmakingPartySnapshot = {
    partyId: string,
    members: string[],
    revision?: number
};

export type MatchmakingPartyResolution = {
    partyId?: string,
    partyMembers?: string[],
    partyRevision?: number,
    excludedMembers: string[],
    partyIdMismatch: boolean
};

// Join-in-progress gate. A party member in Ramsgate may drop into another member's running hunt only while the
// hunt server reports fresh state (its runtime is the one that rescales behemoth health on join), has a free
// slot, is not ending, and the behemoth is not nearly dead. hpPct -1 = no behemoth spawned yet.
export type LateJoinHuntState = { hpPct: number, players: number, subState: number, at: number };

export const LATE_JOIN_MIN_HP_PCT = 20;
export const LATE_JOIN_MAX_PLAYERS = 4;
const LATE_JOIN_STATE_MAX_AGE_MS = 15000;
const SUBSTATE_END_OF_HUNT = 4;

export function LateJoinBlockReason(State: LateJoinHuntState | null | undefined, NowMs: number): string | undefined {
    if (State == undefined) return "NO_HUNT_STATE";
    if (NowMs - State.at > LATE_JOIN_STATE_MAX_AGE_MS) return "STALE_HUNT_STATE";
    if (State.players >= LATE_JOIN_MAX_PLAYERS) return "FULL";
    if (State.subState === SUBSTATE_END_OF_HUNT) return "ENDING";
    if (State.hpPct >= 0 && State.hpPct < LATE_JOIN_MIN_HP_PCT) return "NEARLY_DONE";
    return undefined;
}

export function ResolveMatchmakingParty(
    GameMode: string,
    UserId: string,
    RequestedPartyId: string | undefined,
    Party: MatchmakingPartySnapshot | undefined,
    IsOnline: (AccountId: string) => boolean
): MatchmakingPartyResolution {
    if(Party == undefined){
        return { excludedMembers: [], partyIdMismatch: false };
    }

    const IsIslandRequest = GameMode === "ISLAND";
    if(IsIslandRequest && RequestedPartyId !== Party.partyId){
        return {
            excludedMembers: Party.members.filter((Member) => Member !== UserId),
            partyIdMismatch: true
        };
    }

    const PartyMembers = Party.members.filter((Member) =>
        Member === UserId || !IsIslandRequest || IsOnline(Member)
    );

    return {
        partyId: Party.partyId,
        partyMembers: PartyMembers,
        partyRevision: Party.revision,
        excludedMembers: Party.members.filter((Member) => !PartyMembers.includes(Member)),
        partyIdMismatch: false
    };
}
