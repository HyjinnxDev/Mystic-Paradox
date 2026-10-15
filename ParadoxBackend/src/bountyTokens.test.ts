import assert from "node:assert/strict";
import test from "node:test";
import { IsGameBountyTokenGrant } from "./controllers/inventory";

test("game server bounty token grants are dropped; other sources are not", () => {
    assert.equal(IsGameBountyTokenGrant("TOKEN_BOUNTY_DRAFT_PREMIUM", "UBountyComponent::OnClaimBountyComplete"), true);
    assert.equal(IsGameBountyTokenGrant("TOKEN_BOUNTY_DRAFT", "UBountyComponent::GrantDailyTokens"), true);
    assert.equal(IsGameBountyTokenGrant("CURRENCY_PRESTIGE", "UBountyComponent::OnClaimBountyComplete"), false);
    assert.equal(IsGameBountyTokenGrant("TOKEN_DAILY_CHALLENGE_DRAFT", "UBountyComponent::GrantDailyTokens"), false);
    assert.equal(IsGameBountyTokenGrant("TOKEN_BOUNTY_DRAFT", "Store"), false);
    assert.equal(IsGameBountyTokenGrant("TOKEN_BOUNTY_DRAFT", undefined), false);
});
