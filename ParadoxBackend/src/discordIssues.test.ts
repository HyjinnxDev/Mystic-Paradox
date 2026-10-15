import assert from "node:assert/strict";
import test from "node:test";
import { IssueEmbed } from "./discordIssues";

test("issue embed shows the ticket id and flips to closed with resolution", () => {
    const Issue = { _id: 7, title: "Crash", description: "On load", reporterId: "1", channelId: "2", status: "open" as const, createdAt: new Date(0) };
    const Open = IssueEmbed(Issue);
    assert.equal(Open.title, "#7 Crash");
    assert.deepEqual(Open.fields!.map((f) => f.value), ["Open", "<@1>"]);
    const Closed = IssueEmbed({ ...Issue, status: "closed", closedBy: "3", closeReason: "Fixed in 0.2.36" });
    assert.deepEqual(Closed.fields!.map((f) => f.value), ["Closed", "<@1>", "<@3>", "Fixed in 0.2.36"]);
});
