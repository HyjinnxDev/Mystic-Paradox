import assert from "node:assert/strict";
import test from "node:test";
import { LauncherAccountRecord } from "../persistence";
import { EffectiveApprovalStatus, IsAccountEligible, IsBanActive } from "./accountEligibility";

function account(changes: Partial<LauncherAccountRecord> = {}): LauncherAccountRecord {
    return {
        userId: "user-1",
        displayNameNormalized: "slayer",
        displayName: "Slayer",
        status: "active",
        roles: ["player"],
        createdAt: new Date(0).toISOString(),
        usernameSet: true,
        ...changes
    };
}

test("legacy accounts remain approved during rollout", () => {
    const Legacy = account();
    assert.equal(EffectiveApprovalStatus(Legacy), "approved");
    assert.equal(IsAccountEligible(Legacy), true);
});

test("pending, rejected, disabled, banned, and nameless accounts are ineligible", () => {
    assert.equal(IsAccountEligible(account({ approvalStatus: "pending" })), false);
    assert.equal(IsAccountEligible(account({ approvalStatus: "rejected" })), false);
    assert.equal(IsAccountEligible(account({ status: "disabled" })), false);
    assert.equal(IsAccountEligible(account({ status: "banned" })), false);
    assert.equal(IsAccountEligible(account({ usernameSet: false })), false);
});

test("timed bans lapse on their own; permanent bans don't", () => {
    const Now = Date.parse("2026-10-15T12:00:00Z");
    assert.equal(IsBanActive(account({ status: "banned" }), Now), true);
    assert.equal(IsBanActive(account({ status: "banned", bannedUntil: "2026-10-15T13:00:00Z" }), Now), true);
    assert.equal(IsBanActive(account({ status: "banned", bannedUntil: "2026-10-15T11:00:00Z" }), Now), false);
    assert.equal(IsAccountEligible(account({ status: "banned", bannedUntil: "2000-01-01T00:00:00Z" })), true);
});
