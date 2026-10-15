/*
 * Copyright (C) 2026 Hyjinnx (Dauntless Forever)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// [forever-launcher] GET /content/v1/news: the latest posts of one Discord channel (the announcements
// channel), as { items: [{ date, title, body, image? }] } for the launcher's news dock. The first line of a
// post is its title, the rest its body. DISCORD_NEWS_BOT_TOKEN + DISCORD_NEWS_CHANNEL_ID unset = 404.
// The bot needs View Channel + Read Message History there, and the Message Content intent.
// A post's first image (attachment or embed) is proxied at /content/v1/news/image/<message id>: Discord's
// CDN links are signed and expire, and the launcher only talks to its own host.

import express from "express";
import { logger } from "../logger";

export interface NewsItem { date: string | null; title: string; body: string; image?: string }

interface DiscordImage { url?: string; proxy_url?: string; content_type?: string }

interface DiscordMessage {
    id?: string;
    content?: string;
    timestamp?: string;
    type?: number;
    attachments?: DiscordImage[];
    embeds?: { title?: string; description?: string; image?: DiscordImage; thumbnail?: DiscordImage }[];
}

const CACHE_MS = 60 * 1000; // a deleted post leaves the launcher within ~2 min (this + its own 60 s)
const MAX_ITEMS = 20;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_HOST = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//;
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)(\?|$)/i;

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

// The first picture of a post, as a Discord CDN link (never an outside host).
export function PostImage(M: DiscordMessage): string | null {
    const Candidates = [
        ...(M.attachments ?? []).filter((A) => (A.content_type ? A.content_type.startsWith("image/") : IMAGE_FILE.test(A.url ?? ""))),
        ...(M.embeds ?? []).flatMap((E) => [E.image, E.thumbnail]),
    ];
    for (const C of Candidates) {
        const Url = [C?.proxy_url, C?.url].find((U) => U && IMAGE_HOST.test(U));
        if (Url) return Url;
    }
    return null;
}

// images: filled with message id -> its image's CDN link.
export function DiscordNews(messages: DiscordMessage[], images = new Map<string, string>()): NewsItem[] {
    const Items: NewsItem[] = [];
    for (const M of messages) {
        // 0 = a normal post, 19 = a reply; joins, pins and the like are skipped.
        if (M.type !== undefined && M.type !== 0 && M.type !== 19) continue;
        const Embed = M.embeds?.[0];
        const Text = PlainText(M.content || [Embed?.title, Embed?.description].filter(Boolean).join("\n") || "");
        const Image = M.id && /^\d{5,25}$/.test(M.id) ? PostImage(M) : null;
        if (!Text && !Image) continue;
        const [First, ...Rest] = Text.split("\n");
        const Body = Rest.join("\n").trim();
        const Item: NewsItem = {
            date: M.timestamp ?? null,
            title: Body ? First.trim().slice(0, 120) : "Announcement",
            body: Body || First.trim(),
        };
        if (Image) {
            images.set(M.id!, Image);
            Item.image = `/content/v1/news/image/${M.id}`;
        }
        Items.push(Item);
        if (Items.length >= MAX_ITEMS) break;
    }
    return Items;
}

let Cache: { at: number; items: NewsItem[]; images: Map<string, string> } | null = null;
let Pending: Promise<void> | null = null;

async function FetchNews(token: string, channel: string): Promise<{ items: NewsItem[]; images: Map<string, string> }> {
    const Res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages?limit=50`, {
        headers: { authorization: `Bot ${token}`, "user-agent": "DauntlessForever (news, 1.0)" },
        signal: AbortSignal.timeout(10000),
    });
    if (!Res.ok) throw new Error(`Discord answered ${Res.status}`);
    const Images = new Map<string, string>();
    return { items: DiscordNews((await Res.json()) as DiscordMessage[], Images), images: Images };
}

// false = news is not set up on this server.
async function FreshNews(): Promise<boolean> {
    const Token = process.env.DISCORD_NEWS_BOT_TOKEN?.trim();
    const Channel = process.env.DISCORD_NEWS_CHANNEL_ID?.trim();
    if (!Token || !Channel || !/^\d{5,25}$/.test(Channel)) return false;
    if (!Cache || Date.now() - Cache.at > CACHE_MS) {
        // One Discord call at a time; on failure the last good list stays (or an empty one).
        Pending ??= FetchNews(Token, Channel)
            .then((fresh) => { Cache = { at: Date.now(), ...fresh }; })
            .catch((error) => {
                logger.warn(`[News] Discord channel not read: ${error}`);
                Cache = { at: Date.now(), items: Cache?.items ?? [], images: Cache?.images ?? new Map() };
            })
            .finally(() => { Pending = null; });
        await Pending;
    }
    return true;
}

export const newsRouter = express.Router();

newsRouter.get("/content/v1/news", async (_req, res) => {
    if (!(await FreshNews())) { res.status(404).send(); return; }
    res.setHeader("cache-control", "no-store");
    res.json({ items: Cache?.items ?? [] });
});

newsRouter.get("/content/v1/news/image/:id", async (req, res) => {
    const Url = (await FreshNews()) ? Cache?.images.get(req.params.id) : undefined;
    if (!Url) { res.status(404).send(); return; }
    try {
        const Img = await fetch(Url, { signal: AbortSignal.timeout(20000), redirect: "error" });
        const Type = Img.headers.get("content-type") ?? "";
        if (!Img.ok || !/^image\/(png|jpeg|webp|gif)$/.test(Type) || Number(Img.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) {
            res.status(502).send();
            return;
        }
        const Data = Buffer.from(await Img.arrayBuffer());
        if (Data.length > MAX_IMAGE_BYTES) { res.status(502).send(); return; }
        res.setHeader("content-type", Type);
        res.setHeader("cache-control", "no-store");
        res.send(Data);
    } catch (error) {
        logger.warn(`[News] image not read: ${error}`);
        res.status(502).send();
    }
});
