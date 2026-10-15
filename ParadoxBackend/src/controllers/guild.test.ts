import assert from "node:assert/strict";
import test from "node:test";
import { CheckNameRules, CheckNameplateRules, GUILD_CODE, NormalizeRank } from "./guild";

const Code = (Reply: ReturnType<typeof CheckNameRules>) => Reply?.Code;

test("guild name and nameplate rules map to the client's error codes", () => {
    assert.equal(CheckNameRules("Slayers42"), undefined);
    assert.equal(Code(CheckNameRules("abc")), GUILD_CODE.NameInvalidLength);
    assert.equal(Code(CheckNameRules("bad name")), GUILD_CODE.NameInvalidLength);
    assert.equal(Code(CheckNameRules("a1234567")), GUILD_CODE.NameTooManyNumbers);
    assert.equal(Code(CheckNameRules("aaaaaaab")), GUILD_CODE.NameTooManyLetters);
    assert.equal(Code(CheckNameRules("Sh1tGuild")), GUILD_CODE.NameProfane);
    assert.equal(Code(CheckNameRules("AdminCrew")), GUILD_CODE.NameTaken);
    assert.equal(CheckNameplateRules(""), undefined);
    assert.equal(CheckNameplateRules(null), undefined);
    assert.equal(CheckNameplateRules("SLAY"), undefined);
    assert.equal(Code(CheckNameplateRules("x")), GUILD_CODE.NameplateInvalidLength);
    assert.equal(Code(CheckNameplateRules("GM")), GUILD_CODE.NameplateTaken);
    assert.equal(NormalizeRank("OFFICER"), "Officer");
    assert.equal(NormalizeRank("boss"), undefined);
});
