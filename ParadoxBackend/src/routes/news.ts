/*
 * Copyright (C) 2026 Hyjinnx (Dauntless Forever)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// [forever-launcher] GET /content/v1/news: the latest posts of one Discord channel (the announcements
// channel), as { items: [{ date, title, body }] } for the launcher's news dock. The first line of a post
// is its title, the rest its body. DISCORD_NEWS_BOT_TOKEN + DISCORD_NEWS_CHANNEL_ID unset = 404.
// The bot needs View Channel + Read Message History there, and the Message Content intent.

import express from "express";
import { logger } from "../logger";

export interface NewsItem { date: string | null; title: string; body: string }

interface DiscordMessage {
    content?: string;
    timestamp?: string;
    type?: number;
    embeds?: { title?: string; description?: string }[];
}

const CACHE_MS = 5 * 60 * 1000;
const MAX_ITEMS = 20;

// Discord markup to plain text: mentions, custom emoji, markdown marks, heading hashes.
export function PlainText(text: string): string {
    return text
        .replace(/<a?:(\w+):\d+>/g, ":$1:")
        .replace(/<(?:@[!&]?|#)\d+>/g, "")
        .replace(/<t:(\d+)(?::\w)?>/g, (_m, s) => new Date(Number(s) * 1000).toISOString().slice(0, 10))
        .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
        .replace(/@(everyone|here)\b/g, "")
        .replace(/^\s*-#\s+/gm, "")
        .replace(/^\s*#{1,3}\s+/gm, "")
        .replace(/\*\*|__|~~|\|\||`{1,3}/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
}

export function DiscordNews(messages: DiscordMessage[]): NewsItem[] {
    const Items: NewsItem[] = [];
    for (const M of messages) {
        // 0 = a normal post, 19 = a reply; joins, pins and the like are skipped.
        if (M.type !== undefined && M.type !== 0 && M.type !== 19) continue;
        const Embed = M.embeds?.[0];
        const Text = PlainText(M.content || [Embed?.title, Embed?.description].filter(Boolean).join("\n") || "");
        if (!Text) continue;
        const [First, ...Rest] = Text.split("\n");
        const Body = Rest.join("\n").trim();
        Items.push({
            date: M.timestamp ?? null,
            title: Body ? First.trim().slice(0, 120) : "Announcement",
            body: Body || First.trim(),
        });
        if (Items.length >= MAX_ITEMS) break;
    }
    return Items;
}

let Cache: { at: number; items: NewsItem[] } | null = null;
let Pending: Promise<NewsItem[]> | null = null;

async function FetchNews(token: string, channel: string): Promise<NewsItem[]> {
    const Res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages?limit=50`, {
        headers: { authorization: `Bot ${token}`, "user-agent": "DauntlessForever (news, 1.0)" },
        signal: AbortSignal.timeout(10000),
    });
    if (!Res.ok) throw new Error(`Discord answered ${Res.status}`);
    return DiscordNews((await Res.json()) as DiscordMessage[]);
}

export const newsRouter = express.Router();

newsRouter.get("/content/v1/news", async (_req, res) => {
    const Token = process.env.DISCORD_NEWS_BOT_TOKEN?.trim();
    const Channel = process.env.DISCORD_NEWS_CHANNEL_ID?.trim();
    if (!Token || !Channel || !/^\d{5,25}$/.test(Channel)) { res.status(404).send(); return; }
    if (!Cache || Date.now() - Cache.at > CACHE_MS) {
        // One Discord call at a time; on failure the last good list stays (or an empty one).
        Pending ??= FetchNews(Token, Channel)
            .then((items) => { Cache = { at: Date.now(), items }; return items; })
            .catch((error) => {
                logger.warn(`[News] Discord channel not read: ${error}`);
                Cache = { at: Date.now() - CACHE_MS + 60000, items: Cache?.items ?? [] }; // retry in a minute
                return Cache.items;
            })
            .finally(() => { Pending = null; });
        await Pending;
    }
    res.setHeader("cache-control", "no-store");
    res.json({ items: Cache?.items ?? [] });
});
