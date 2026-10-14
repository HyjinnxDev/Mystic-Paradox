/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Answer, Availability, DeleteInvites, DeleteLink, HuntedTogetherSlots, Invite, LinksList, RewardsGrant, SaveRewards, SlayerLinkResult, SlayerLinkRow, Status } from "./slayerLinks";

const H = 60 * 60 * 1000;
const payload = (r: { body: unknown }) => (r.body as any).payload;

// A tiny in-memory store standing in for the Mongo collection
function Store() {
    let rows: SlayerLinkRow[] = [];
    return {
        get rows() { return rows; },
        apply(r: SlayerLinkResult) {
            for (const p of r.put ?? []) rows = [...rows.filter((x) => x._id !== p._id), p];
            if (r.remove) rows = rows.filter((x) => x._id !== r.remove);
            return r;
        }
    };
}

test("invite, accept, list, remove: full Slayer Link round trip", () => {
    const s = Store();
    const aFriends = new Set(["B"]), bFriends = new Set(["A"]);

    assert.equal(Invite(s.rows, "A", new Set(), { account_id: "B", slot: 1 }, 0, "x").reply.status, 403);
    assert.equal(Invite(s.rows, "A", aFriends, { account_id: "B", slot: 0 }, 0, "x").reply.status, 400);
    assert.equal(Invite(s.rows, "A", aFriends, { account_id: "B", slot: 4 }, 0, "x").reply.status, 400);

    const inv = s.apply(Invite(s.rows, "A", aFriends, { account_id: "B", slot: 2 }, 0, "L1"));
    assert.deepEqual(payload(inv.reply), { link_id: "L1" });
    assert.deepEqual(payload(Invite(s.rows, "A", aFriends, { account_id: "B", slot: 2 }, 1, "L2").reply), { link_id: "L1" }, "repeat invite answers same id");
    assert.equal(Invite(s.rows, "B", bFriends, { account_id: "A", slot: 1 }, 1, "L3").reply.status, 409, "other already invited you");

    const bView = payload(Status(s.rows, "B", 1));
    assert.deepEqual(bView.invites.map((i: any) => [i.account_id, i.direction, i.slot, i.link_id]), [["A", "Received", 2, "L1"]]);
    assert.deepEqual(bView.config, { link_duration_hours: 168, invite_expiry_hours: 24 });

    assert.equal(s.apply(Answer(s.rows, "B", bFriends, { account_id: "A", action: "accept", slot: 3 }, 2)).reply.status, 200);
    assert.equal(Answer(s.rows, "B", bFriends, { account_id: "A", action: "accept" }, 3).reply.status, 200, "repeated accept is 200");

    const aLinks = payload(Status(s.rows, "A", 3)).links;
    const bLinks = payload(Status(s.rows, "B", 3)).links;
    assert.deepEqual(aLinks.map((l: any) => [l.account_id, l.linked_account_id, l.slot]), [["B", "B", 2]]);
    assert.deepEqual(bLinks.map((l: any) => [l.account_id, l.slot]), [["A", 3]]);
    assert.equal(payload(Status(s.rows, "A", 3)).invites.length, 0);
    assert.equal(payload(Status(s.rows, "A", 169 * H)).links.length, 0, "link ends after a week");

    assert.equal(Invite(s.rows, "A", aFriends, { account_id: "B", slot: 1 }, 4, "L4").reply.status, 409, "already linked");
    assert.deepEqual(payload(Availability(s.rows, "A", aFriends, ["B", "C"], 4)).availability,
        [{ account_id: "B", available: false }, { account_id: "C", available: false }]);

    s.apply(DeleteLink(s.rows, "B", { slot: 3 }, {}, 5));
    assert.equal(payload(Status(s.rows, "A", 5)).links.length, 0, "removed for both");
    assert.deepEqual(payload(Availability(s.rows, "A", aFriends, ["B"], 5)).availability, [{ account_id: "B", available: true }]);
});

test("link XP only for links whose partner is in the party", () => {
    const s = Store();
    const f = new Set(["A", "B", "C"]);
    s.apply(Invite(s.rows, "A", f, { account_id: "B", slot: 2 }, 0, "L1"));
    s.apply(Answer(s.rows, "B", f, { account_id: "A", action: "accept", slot: 3 }, 1));
    s.apply(Invite(s.rows, "A", f, { account_id: "C", slot: 1 }, 1, "L2"));
    s.apply(Answer(s.rows, "C", f, { account_id: "A", action: "accept", slot: 1 }, 2));
    assert.deepEqual(HuntedTogetherSlots(s.rows, "A", ["A", "B"], 3), [2]);
    assert.deepEqual(HuntedTogetherSlots(s.rows, "B", ["A", "B"], 3), [3]);
    assert.deepEqual(HuntedTogetherSlots(s.rows, "A", ["A"], 3), [], "solo hunt gives no link XP");
    assert.deepEqual(HuntedTogetherSlots(s.rows, "A", ["A", "B"], 169 * H), [], "ended link gets no XP");
});

test("reject, cancel, expiry, delete-all", () => {
    const s = Store();
    const f = new Set(["A", "B", "C"]);
    s.apply(Invite(s.rows, "A", f, { account_id: "B", slot: 1 }, 0, "I1"));
    s.apply(Answer(s.rows, "B", f, { account_id: "A", action: "reject" }, 1));
    assert.equal(Answer(s.rows, "B", f, { account_id: "A", action: "accept" }, 2).reply.status, 409, "already declined");

    s.apply(Invite(s.rows, "A", f, { account_id: "B", slot: 1 }, 3, "I2"));
    s.apply(Answer(s.rows, "A", f, { account_id: "B", action: "cancel" }, 4));
    assert.equal(payload(Status(s.rows, "B", 5)).invites.length, 0);

    s.apply(Invite(s.rows, "A", f, { account_id: "C", slot: 1 }, 10, "I3"));
    assert.equal(Answer(s.rows, "C", f, { account_id: "A", action: "accept" }, 10 + 25 * H).reply.status, 409, "invite ran out");

    s.apply(Invite(s.rows, "A", f, { account_id: "B", slot: 2 }, 100, "I4"));
    s.apply(Invite(s.rows, "C", f, { account_id: "A", slot: 1 }, 100, "I5"));
    const del = s.apply(DeleteInvites(s.rows, "A", "A", 101));
    assert.equal(del.put?.length, 2);
    assert.equal(payload(Status(s.rows, "A", 102)).invites.length, 0);
});

test("rewards: accept resets both slot tracks, pool is stored per player, grant answers once", () => {
    const s = Store();
    s.apply(Invite(s.rows, "A", new Set(["B"]), { account_id: "B", slot: 2 }, 0, "L1"));
    const acc = s.apply(Answer(s.rows, "B", new Set(["A"]), { account_id: "A", action: "accept", slot: 3 }, 1));
    assert.deepEqual(acc.resetTracks, [["A", "Linked_Slayer_Slot_2"], ["B", "Linked_Slayer_Slot_3"]]);

    const pool = [{ catalog_id: "CURRENCY_RAMS", quantity: 500, received_for_level: 1 }];
    assert.equal(SaveRewards(s.rows, "A", { slot: 1, prize_pool: pool }, 2).reply.status, 404, "no link in slot 1");
    assert.equal(SaveRewards(s.rows, "A", { slot: 2, prize_pool: [{ catalog_id: "", quantity: 1, received_for_level: 1 }] }, 2).reply.status, 400);
    s.apply(SaveRewards(s.rows, "A", { slot: 2, prize_pool: pool }, 2));
    assert.deepEqual(payload(LinksList(s.rows, "A", 3)).links[0].prize_pool, pool);
    assert.deepEqual(payload(LinksList(s.rows, "B", 3)).links[0].prize_pool, [], "B's pool is its own");

    // after the week ends the grant still works once, then 409; after the grace period 404
    const ended = 1 + 168 * H + 1;
    const g = s.apply(RewardsGrant(s.rows, "A", "2", ended));
    assert.deepEqual(payload(g.reply), { is_service_granting: false });
    assert.equal(RewardsGrant(s.rows, "A", 2, ended).reply.status, 409);
    assert.equal(s.apply(RewardsGrant(s.rows, "B", 3, ended)).reply.status, 200);
    assert.equal(RewardsGrant(s.rows, "A", 2, 1 + 2 * 168 * H + 1).reply.status, 404);
});
