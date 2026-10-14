import assert from "node:assert/strict";
import test from "node:test";
import { CanActOn, HasStaffPermission, StaffNameTag, StaffRank, StripStaffNameTag } from "./staffRoles";

test("staff tiers gate permissions", () => {
    assert.equal(StaffRank(["player"]), 0);
    assert.equal(StaffRank(["player", "tester"]), 0);
    assert.equal(HasStaffPermission(["moderator"], "players.ban.timed"), true);
    assert.equal(HasStaffPermission(["moderator"], "players.access"), false);
    assert.equal(HasStaffPermission(["admin"], "players.access"), true);
    assert.equal(HasStaffPermission(["admin"], "players.roles"), false);
    assert.equal(HasStaffPermission(["admin", "owner"], "players.delete"), true);
});

test("staff only act on lower ranks, never themselves or peers", () => {
    assert.equal(CanActOn(["moderator"], ["player"]), true);
    assert.equal(CanActOn(["moderator"], ["moderator"]), false);
    assert.equal(CanActOn(["moderator"], ["admin"]), false);
    assert.equal(CanActOn(["admin"], ["moderator"]), true);
    assert.equal(CanActOn(["admin", "owner"], ["admin", "owner"]), false);
});

test("staff name tag round-trips", () => {
    assert.equal(StaffNameTag(["player", "admin", "owner"]), "[Owner] ");
    assert.equal(StaffNameTag(["admin"]), "[Admin] ");
    assert.equal(StaffNameTag(["moderator"]), "");
    assert.equal(StripStaffNameTag("[Owner] Hyjinnx"), "Hyjinnx");
    assert.equal(StripStaffNameTag("Hyjinnx"), "Hyjinnx");
});
