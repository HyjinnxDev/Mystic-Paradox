/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

// Slayer Links (social panel, Linked Slayers tab): two friends link up for a week. Pure rules; the Mongo I/O
// and the routes are in routes/slayerLinks.ts. Contract ported from dauntless-revived (1.4.4,
// UndauntedMetagame/src/controllers/slayerlinks.ts, traced against that exe):
//   GET    /slayerlink/status_good   -> {invites, links, config: {link_duration_hours, invite_expiry_hours}}
//   GET    /slayerlink/invites       -> {invites: [{account_id, slot, direction, status, expires, link_id}]}
//   GET    /slayerlink/links         -> {links: [{account_id, linked_account_id, slot, ends, link_id, prize_pool}]}
//   PUT    /slayerlink/invite        {account_id, slot}            -> {link_id}
//   POST   /slayerlink/invite        {account_id, action, slot}    -> {link_id}; action accept|reject|cancel
//   DELETE /slayerlink/invites/:id   own id = all my invites, other id = those between us -> {}
//   DELETE /slayerlink/links         {account_id, slot} (body or query) -> {}
//   POST   /slayerlink/availability  {account_ids} -> {availability: [{account_id, available}]}
// Rewards (traced on the 1.14.7 exe, 2026-10-13). The game server's ULinkedSlayerComponent draws the prize pool
// itself (GeneratePrizePoolInternal 0x19ff90e, from LinkedSlayerRewardsTable/ConfigTable plus the progression
// config track Linked_Slayer_Slot_1) and grants the items through PlayerInventory ("SlayerLinks.GrantRewards",
// 0x1a1076b). The backend only keeps the pool and answers the grant check:
//   PUT    /slayerlink/links/rewards {account_id, slot, prize_pool: [{catalog_id, quantity, received_for_level}]}
//          (FOnlineLinkedSlayer::SendLinkRewards 0x1c80e08, body serializer 0x1c8379f, entry 0x1c850e0) -> {}
//   GET    /slayerlink/links/rewards/:account_id/:slot (GetLinkRewardsGrant 0x1c64500) -> {is_service_granting}
//          (0x1c825af). false = the game server grants; answered once per player per link (409 after).
// Link progress is the per-player progression track Linked_Slayer_Slot_<slot>, reset for both players on accept.
// Slots are 1..3 (the client's slot-map keys). One row per invite; an accepted invite becomes the link
// (same id, status LINKED). Envelope {code, message, payload}; errors {code: "<status>", message, payload: null}.
// ponytail: no blocklist (friends.ts has none yet) and no per-player invite rate limit (3 slots = 3 pending
// invites max); add both if blocking or spam becomes real.

export const LINK_SLOTS = 3;
export const INVITE_EXPIRY_HOURS = 24;
export const LINK_DURATION_HOURS = 168;
export const MAX_AVAILABILITY_IDS = 50;
// An ended link is kept this long so its rewards can still be granted
export const REWARD_GRACE_HOURS = 168;
export const MAX_PRIZES = 50;
export const LINK_TRACK_PREFIX = "Linked_Slayer_Slot_";
const HOUR_MS = 60 * 60 * 1000;
const ALL_SLOTS = Array.from({ length: LINK_SLOTS }, (_, i) => i + 1);

export type SlayerLinkStatus = "PENDING" | "LINKED" | "DECLINED" | "CANCELED";

export interface SlayerLinkRow {
    _id: string;
    senderId: string;
    targetId: string;
    senderSlot: number;
    targetSlot: number | null;
    status: SlayerLinkStatus;
    createdAt: number;
    expiresAt: number;
    endsAt: number | null;
    prizePools?: Record<string, LinkPrize[]>;   // by player id
    rewardsGranted?: string[];                  // player ids whose grant check was answered
}

export interface LinkPrize { catalog_id: string; quantity: number; received_for_level: number; }
export interface SlayerLinkReply { status: number; body: unknown; }
// resetTracks: progression tracks to clear (a new link starts its progress at 0), as [playerId, trackId]
export interface SlayerLinkResult { reply: SlayerLinkReply; put?: SlayerLinkRow[]; remove?: string; resetTracks?: [string, string][]; log: string; }

type Action = "accept" | "reject" | "cancel";
const ANSWERED: Record<Action, SlayerLinkStatus> = { accept: "LINKED", reject: "DECLINED", cancel: "CANCELED" };

const Ok = (payload: unknown): SlayerLinkReply => ({ status: 200, body: { code: null, message: "OK", payload } });
const Fail = (status: number, message: string): SlayerLinkReply => ({ status, body: { code: String(status), message, payload: null } });

function SlotOf(value: unknown): number | undefined {
    const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,2}$/.test(value) ? Number(value) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= LINK_SLOTS ? n : undefined;
}

const IsId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
const Other = (r: SlayerLinkRow, me: string) => (r.senderId === me ? r.targetId : r.senderId);
const Involves = (r: SlayerLinkRow, id: string) => r.senderId === id || r.targetId === id;
const IsPending = (r: SlayerLinkRow, now: number) => r.status === "PENDING" && r.expiresAt > now;
const IsLinked = (r: SlayerLinkRow, now: number) => r.status === "LINKED" && (r.endsAt ?? 0) > now;
const LinkSlot = (r: SlayerLinkRow, me: string) => (r.senderId === me ? r.senderSlot : r.targetSlot ?? 0);

const PendingOf = (rows: SlayerLinkRow[], me: string, now: number) => rows.filter((r) => Involves(r, me) && IsPending(r, now));
const LinksOf = (rows: SlayerLinkRow[], me: string, now: number) => rows.filter((r) => Involves(r, me) && IsLinked(r, now));
const LinkedWith = (rows: SlayerLinkRow[], a: string, b: string, now: number) => LinksOf(rows, a, now).some((r) => Other(r, a) === b);

// My active link slots whose partner is in my party: a hunt's XP counts for a link only when hunted together.
export const HuntedTogetherSlots = (rows: SlayerLinkRow[], me: string, partyMembers: string[], now: number) =>
    LinksOf(rows, me, now).filter((r) => partyMembers.includes(Other(r, me))).map((r) => LinkSlot(r, me)).filter((s) => s >= 1);

function FreeSlots(rows: SlayerLinkRow[], me: string, now: number): number[] {
    const used = new Set(LinksOf(rows, me, now).map((r) => LinkSlot(r, me)));
    return ALL_SLOTS.filter((s) => !used.has(s));
}

function Lists(rows: SlayerLinkRow[], me: string, now: number) {
    return {
        invites: PendingOf(rows, me, now)
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((r) => ({
                account_id: Other(r, me),
                slot: r.senderSlot,
                direction: r.senderId === me ? "Sent" : "Received",
                status: "Pending",
                expires: new Date(r.expiresAt).toISOString(),
                link_id: r._id
            })),
        // The links list reads account_id, the status reply linked_account_id: every entry carries both.
        links: LinksOf(rows, me, now)
            .map((r) => ({
                account_id: Other(r, me),
                linked_account_id: Other(r, me),
                slot: LinkSlot(r, me),
                ends: new Date(r.endsAt ?? 0).toISOString(),
                link_id: r._id,
                prize_pool: r.prizePools?.[me] ?? []
            }))
            .sort((a, b) => a.slot - b.slot)
    };
}

export function Status(rows: SlayerLinkRow[], me: string, now: number): SlayerLinkReply {
    return Ok({ ...Lists(rows, me, now), config: { link_duration_hours: LINK_DURATION_HOURS, invite_expiry_hours: INVITE_EXPIRY_HOURS } });
}

export function InvitesList(rows: SlayerLinkRow[], me: string, now: number): SlayerLinkReply {
    return Ok({ invites: Lists(rows, me, now).invites });
}

export function LinksList(rows: SlayerLinkRow[], me: string, now: number): SlayerLinkReply {
    return Ok({ links: Lists(rows, me, now).links });
}

// PUT /slayerlink/invite. rows: every row involving me or the target.
export function Invite(rows: SlayerLinkRow[], me: string, friends: Set<string>, body: any, now: number, newId: string): SlayerLinkResult {
    const target = body?.account_id;
    const slot = SlotOf(body?.slot);
    const refuse = (status: number, why: string): SlayerLinkResult =>
        ({ reply: Fail(status, why), log: `invite by=${me} to=${IsId(target) ? target : "?"} slot=${slot ?? "?"} refused ${status}: ${why}` });

    if (!IsId(target)) return refuse(400, "no account to invite");
    if (slot === undefined) return refuse(400, `the slot must be 1 to ${LINK_SLOTS}`);
    if (target === me) return refuse(409, "you cannot link with yourself");
    if (!friends.has(target)) return refuse(403, "only friends can link");

    const pending = PendingOf(rows, me, now);
    const again = pending.find((r) => r.senderId === me && r.targetId === target);
    if (again) return { reply: Ok({ link_id: again._id }), log: `invite by=${me} to=${target} -> already invited id=${again._id}` };
    if (pending.some((r) => r.senderId === target)) return refuse(409, "this player already invited you");
    if (LinkedWith(rows, me, target, now)) return refuse(409, "already linked with this player");
    if (!FreeSlots(rows, me, now).includes(slot)) return refuse(409, "the slot is already linked");
    if (pending.some((r) => r.senderId === me && r.senderSlot === slot)) return refuse(409, "the slot already has an invite waiting");
    if (FreeSlots(rows, target, now).length === 0) return refuse(409, "the player has no free slot");

    const row: SlayerLinkRow = {
        _id: newId, senderId: me, targetId: target, senderSlot: slot, targetSlot: null,
        status: "PENDING", createdAt: now, expiresAt: now + INVITE_EXPIRY_HOURS * HOUR_MS, endsAt: null
    };
    return { reply: Ok({ link_id: newId }), put: [row], log: `invite by=${me} to=${target} slot=${slot} -> sent id=${newId}` };
}

// POST /slayerlink/invite. accept/reject: account_id = the sender; cancel: account_id = the invited player.
export function Answer(rows: SlayerLinkRow[], me: string, friends: Set<string>, body: any, now: number): SlayerLinkResult {
    const action = (typeof body?.action === "string" ? body.action.toLowerCase() : "") as Action;
    const other = body?.account_id;
    const refuse = (status: number, why: string): SlayerLinkResult =>
        ({ reply: Fail(status, why), log: `${action || "answer"} by=${me} other=${IsId(other) ? other : "?"} refused ${status}: ${why}` });

    if (!(action in ANSWERED)) return refuse(400, "the action must be accept, reject or cancel");
    if (!IsId(other)) return refuse(400, "no account");

    const [sender, target] = action === "cancel" ? [me, other] : [other, me];
    // The pending invite if there is one, else the latest (a repeated answer finds it)
    const mine = rows.filter((r) => r.senderId === sender && r.targetId === target).sort((a, b) => a.createdAt - b.createdAt);
    const row = mine.find((r) => r.status === "PENDING") ?? mine.at(-1);

    if (!row) return refuse(404, "no such invite");
    if (row.status === ANSWERED[action]) return { reply: Ok({ link_id: row._id }), log: `${action} by=${me} other=${other} id=${row._id} -> already done` };
    if (row.status !== "PENDING") return refuse(409, `the invite was already ${row.status.toLowerCase()}`);
    if (row.expiresAt <= now) return refuse(409, "the invite ran out");

    const done: SlayerLinkRow = { ...row, status: ANSWERED[action] };
    if (action === "accept") {
        if (!friends.has(other)) return refuse(403, "only friends can link");
        if (LinkedWith(rows, sender, target, now)) return refuse(409, "already linked with this player");
        if (!FreeSlots(rows, sender, now).includes(row.senderSlot)) return refuse(409, "the other player's slot is taken");
        const free = FreeSlots(rows, me, now);
        const asked = SlotOf(body?.slot);
        const slot = asked !== undefined && free.includes(asked) ? asked : free[0];
        if (slot === undefined) return refuse(409, "no free slot");
        done.targetSlot = slot;
        done.endsAt = now + LINK_DURATION_HOURS * HOUR_MS;
    }
    const resetTracks: [string, string][] | undefined = action === "accept"
        ? [[sender, LINK_TRACK_PREFIX + row.senderSlot], [target, LINK_TRACK_PREFIX + done.targetSlot]] : undefined;
    return { reply: Ok({ link_id: row._id }), put: [done], resetTracks, log: `${action} by=${me} other=${other} id=${row._id} -> ${done.status.toLowerCase()}${done.targetSlot ? ` (slots ${row.senderSlot} and ${done.targetSlot})` : ""}` };
}

// DELETE /slayerlink/invites/:accountId
export function DeleteInvites(rows: SlayerLinkRow[], me: string, accountId: unknown, now: number): SlayerLinkResult {
    if (!IsId(accountId)) return { reply: Fail(400, "no account"), log: `delete invites by=${me} refused 400: no account` };
    const put = PendingOf(rows, me, now)
        .filter((r) => accountId === me || Other(r, me) === accountId)
        .map((r): SlayerLinkRow => ({ ...r, status: r.senderId === me ? "CANCELED" : "DECLINED" }));
    return { reply: Ok({}), put, log: `delete invites by=${me} of=${accountId === me ? "all" : accountId} -> ${put.length} closed` };
}

// DELETE /slayerlink/links: ends the link for both players. Nothing to remove is still 200.
export function DeleteLink(rows: SlayerLinkRow[], me: string, body: any, query: any, now: number): SlayerLinkResult {
    const slot = SlotOf(body?.slot ?? query?.slot);
    const other = body?.account_id ?? query?.account_id;
    const hasOther = IsId(other);
    if (slot === undefined && !hasOther) return { reply: Fail(400, "no slot or account"), log: `delete link by=${me} refused 400: no slot or account` };

    const links = LinksOf(rows, me, now);
    const link = links.find((r) => (slot === undefined || LinkSlot(r, me) === slot) && (!hasOther || Other(r, me) === other))
        ?? links.find((r) => hasOther && Other(r, me) === other)
        ?? links.find((r) => slot !== undefined && LinkSlot(r, me) === slot);
    return { reply: Ok({}), remove: link?._id, log: `delete link by=${me} slot=${slot ?? "-"} other=${hasOther ? other : "-"} -> ${link ? `removed ${link._id}` : "nothing to remove"}` };
}

// The owner's link in that slot, newest first; an ended link counts for REWARD_GRACE_HOURS (rewards come at the end)
function RewardLink(rows: SlayerLinkRow[], owner: string, slot: number, now: number): SlayerLinkRow | undefined {
    return rows
        .filter((r) => r.status === "LINKED" && Involves(r, owner) && LinkSlot(r, owner) === slot
            && (r.endsAt ?? 0) + REWARD_GRACE_HOURS * HOUR_MS > now)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
}

function Prizes(value: unknown): LinkPrize[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_PRIZES) return undefined;
    const out: LinkPrize[] = [];
    for (const p of value) {
        const id = p?.catalog_id, q = Number(p?.quantity), lvl = Number(p?.received_for_level);
        if (typeof id !== "string" || id.length === 0 || id.length > 128 || !Number.isInteger(q) || q < 1 || q > 100000
            || !Number.isInteger(lvl) || lvl < 0 || lvl > 1000) return undefined;
        out.push({ catalog_id: id, quantity: q, received_for_level: lvl });
    }
    return out;
}

// PUT /slayerlink/links/rewards. owner: whose slot (the player, or account_id when a game server sends it).
export function SaveRewards(rows: SlayerLinkRow[], owner: string, body: any, now: number): SlayerLinkResult {
    const slot = SlotOf(body?.slot);
    const pool = Prizes(body?.prize_pool);
    const refuse = (status: number, why: string): SlayerLinkResult =>
        ({ reply: Fail(status, why), log: `rewards save for=${owner} slot=${slot ?? "?"} refused ${status}: ${why}` });
    if (slot === undefined) return refuse(400, `the slot must be 1 to ${LINK_SLOTS}`);
    if (!pool) return refuse(400, "prize_pool must be a list of {catalog_id, quantity, received_for_level}");
    const link = RewardLink(rows, owner, slot, now);
    if (!link) return refuse(404, "no link in this slot");
    const done: SlayerLinkRow = { ...link, prizePools: { ...link.prizePools, [owner]: pool } };
    const summary = pool.map((p) => `${p.catalog_id}x${p.quantity}@${p.received_for_level}`).join(",");
    return { reply: Ok({}), put: [done], log: `rewards save for=${owner} slot=${slot} id=${link._id} -> ${pool.length} prizes [${summary}]` };
}

// GET /slayerlink/links/rewards/:account_id/:slot
export function RewardsGrant(rows: SlayerLinkRow[], owner: string, slotValue: unknown, now: number): SlayerLinkResult {
    const slot = SlotOf(slotValue);
    const refuse = (status: number, why: string): SlayerLinkResult =>
        ({ reply: Fail(status, why), log: `rewards grant for=${owner} slot=${slot ?? "?"} refused ${status}: ${why}` });
    if (slot === undefined) return refuse(400, `the slot must be 1 to ${LINK_SLOTS}`);
    const link = RewardLink(rows, owner, slot, now);
    if (!link) return refuse(404, "no link in this slot");
    if (link.rewardsGranted?.includes(owner)) return refuse(409, "the rewards of this link were already granted");
    const done: SlayerLinkRow = { ...link, rewardsGranted: [...(link.rewardsGranted ?? []), owner] };
    return { reply: Ok({ is_service_granting: false }), put: [done], log: `rewards grant for=${owner} slot=${slot} id=${link._id} -> game server grants (${link.prizePools?.[owner]?.length ?? 0} prizes stored)` };
}

export function AvailabilityIds(body: any): string[] {
    return [...new Set<string>((Array.isArray(body?.account_ids) ? body.account_ids : []).filter(IsId))].slice(0, MAX_AVAILABILITY_IDS);
}

// POST /slayerlink/availability. rows: every row involving me or any of ids.
export function Availability(rows: SlayerLinkRow[], me: string, friends: Set<string>, ids: string[], now: number): SlayerLinkReply {
    const pending = PendingOf(rows, me, now);
    const haveSlot = FreeSlots(rows, me, now).some((s) => !pending.some((r) => r.senderId === me && r.senderSlot === s));
    return Ok({
        availability: ids.map((id) => ({
            account_id: id,
            available: haveSlot && id !== me && friends.has(id) && !LinkedWith(rows, me, id, now)
                && !pending.some((r) => Other(r, me) === id) && FreeSlots(rows, id, now).length > 0
        }))
    });
}
