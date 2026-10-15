import assert from "node:assert/strict";
import test from "node:test";
import { DiscordNews, PlainText, PostImage } from "./news";

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

test("a post's first Discord-hosted image is proxied; outside hosts and non-images are not", () => {
    const Images = new Map<string, string>();
    const Items = DiscordNews([
        { id: "111111", type: 0, content: "Patch\nNotes", attachments: [
            { url: "https://cdn.discordapp.com/a/notes.txt", content_type: "text/plain" },
            { url: "https://cdn.discordapp.com/a/shot.png?ex=1", proxy_url: "https://media.discordapp.net/a/shot.png?ex=1", content_type: "image/png" },
        ] },
        { id: "222222", type: 0, content: "", attachments: [{ url: "https://cdn.discordapp.com/a/only.webp" }] },
        { id: "333333", type: 0, content: "Link", embeds: [{ image: { url: "https://evil.example/x.png" } }] },
    ], Images);
    assert.equal(Items[0].image, "/content/v1/news/image/111111");
    assert.equal(Images.get("111111"), "https://media.discordapp.net/a/shot.png?ex=1");
    assert.deepEqual(Items[1], { date: null, title: "Announcement", body: "", image: "/content/v1/news/image/222222" });
    assert.equal(Items[2].image, undefined);
    assert.equal(PostImage({ embeds: [{ thumbnail: { url: "https://cdn.discordapp.com/t.jpg" } }] }), "https://cdn.discordapp.com/t.jpg");
});
