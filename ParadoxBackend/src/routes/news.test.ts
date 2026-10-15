import assert from "node:assert/strict";
import test from "node:test";
import { DiscordNews, PlainText } from "./news";

test("Discord posts become launcher news: first line title, markup stripped, system messages skipped", () => {
    const Items = DiscordNews([
        { type: 0, timestamp: "2026-10-15T10:00:00Z", content: "# **Runtime 0.2.36** <:goat:123>\n@everyone Projectiles hit again <@456>.\nSee <https://example.com>" },
        { type: 6, content: "pinned a message" },
        { type: 0, content: "Server restart at 8pm" },
        { type: 0, content: "", embeds: [{ title: "Patch", description: "Hunts fixed" }] },
        { type: 0, content: "" },
    ]);
    assert.deepEqual(Items, [
        { date: "2026-10-15T10:00:00Z", title: "Runtime 0.2.36 :goat:", body: "Projectiles hit again .\nSee https://example.com" },
        { date: null, title: "Announcement", body: "Server restart at 8pm" },
        { date: null, title: "Patch", body: "Hunts fixed" },
    ]);
    assert.equal(PlainText("||spoiler|| `code` ~~old~~"), "spoiler code old");
});
