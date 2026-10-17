/*
 * Copyright (C) 2026 Hyjinnx (Dauntless Forever)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// [forever-launcher] The server's card in the launcher's server list: a title, a message of the day and a
// logo, set by the owner on the staff console (/admin, "Launcher card").
//   GET /launcher/v1/info        public: { title, motd, logo: path | null, playersOnline }
//   GET /launcher/v1/info/logo   public: the logo image
//   GET|PUT /admin/v1/launcher-card, PUT|DELETE /admin/v1/launcher-card/logo, GET /admin/v1/launcher-card/invite
// Stored as one Mongo document; the public routes serve an in-memory copy.

import crypto, { X509Certificate } from "crypto";
import fs from "fs";
import express, { Request, Response } from "express";
import { logger } from "../logger";
import { GetMongoDb } from "../persistence/mongo/client";
import { GetRepositories } from "../persistence";
import { HasAdminAuth, RequireStaff } from "../middleware/HasAdminAuth";
import { sessionRegistry } from "../realtime/SessionRegistry";

interface CardDoc {
    _id: string;
    title: string;
    motd: string;
    logo?: Buffer;
    logoType?: string;
    updatedAt: string;
}

export interface CardText { title: string; motd: string }

const COLLECTION = "launcher_card";
const DOC_ID = "card";
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const MAX_TITLE = 48;
export const MAX_MOTD = 300;

// Control characters (line feeds aside for the MOTD) and bidirectional overrides are dropped.
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function CleanCardText(raw: unknown): CardText | null {
    if (typeof raw !== "object" || raw === null) return null;
    const { title, motd } = raw as Record<string, unknown>;
    if (typeof title !== "string" || typeof motd !== "string") return null;
    const Title = title.replace(UNSAFE, "").replace(/\s+/g, " ").trim();
    const Motd = motd.replace(/\r\n?/g, "\n").replace(UNSAFE, "").replace(/\n{3,}/g, "\n\n").trim();
    if (Array.from(Title).length > MAX_TITLE || Array.from(Motd).length > MAX_MOTD) return null;
    return { title: Title, motd: Motd };
}

// The image type from the first bytes; what the browser says is not trusted.
export function LogoType(data: Buffer): string | null {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (data.length >= 12 && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
    return null;
}

let Cached: { doc: CardDoc | null; logoHash: string | null } | undefined;

async function Card(): Promise<{ doc: CardDoc | null; logoHash: string | null }> {
    if (Cached) return Cached;
    const Db = await GetMongoDb();
    const Doc = await Db.collection<CardDoc>(COLLECTION).findOne({ _id: DOC_ID });
    if (Doc?.logo) Doc.logo = Buffer.from((Doc.logo as any).buffer ?? Doc.logo);
    Cached = { doc: Doc, logoHash: Doc?.logo ? crypto.createHash("sha256").update(Doc.logo).digest("hex").slice(0, 16) : null };
    return Cached;
}

async function Save(change: Partial<CardDoc>, unset?: "logo"): Promise<void> {
    const Db = await GetMongoDb();
    await Db.collection<CardDoc>(COLLECTION).updateOne(
        { _id: DOC_ID },
        {
            $set: { ...change, updatedAt: new Date().toISOString() },
            ...(change.title === undefined ? { $setOnInsert: { title: "", motd: "" } } : {}),
            ...(unset ? { $unset: { logo: "", logoType: "" } } : {}),
        } as any,
        { upsert: true }
    );
    Cached = undefined;
}

function PublicCard(c: { doc: CardDoc | null; logoHash: string | null }) {
    return {
        title: c.doc?.title ?? "",
        motd: c.doc?.motd ?? "",
        logo: c.logoHash ? `/launcher/v1/info/logo?v=${c.logoHash}` : null,
    };
}

async function Audit(req: Request, action: string, newState: unknown): Promise<void> {
    const Actor = (req as any).AdminAuth.account;
    await GetRepositories().admin.appendAudit({
        id: crypto.randomUUID(),
        actorUserId: Actor.userId,
        action,
        newState,
        ip: req.ip ?? "unknown",
        requestId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
    });
}

async function Wrap(res: Response, fn: () => Promise<void>): Promise<void> {
    try { await fn(); }
    catch (error) {
        logger.error(`[LauncherCard] ${error}`);
        if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL", message: "Launcher card failed." } });
    }
}

export const launcherCardRouter = express.Router();

launcherCardRouter.get("/launcher/v1/info", (_req, res) => Wrap(res, async () => {
    res.setHeader("cache-control", "no-store");
    res.json({ ...PublicCard(await Card()), playersOnline: sessionRegistry.onlineAccountCount() });
}));

launcherCardRouter.get("/launcher/v1/info/logo", (_req, res) => Wrap(res, async () => {
    const { doc } = await Card();
    if (!doc?.logo || !doc.logoType) { res.status(404).send(); return; }
    res.setHeader("content-type", doc.logoType);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-cache");
    res.send(doc.logo);
}));

const Owner = [HasAdminAuth, RequireStaff("operations")];

launcherCardRouter.get("/admin/v1/launcher-card", ...Owner, (_req: Request, res: Response) => Wrap(res, async () => {
    res.json({ ...PublicCard(await Card()), limits: { title: MAX_TITLE, motd: MAX_MOTD, logoBytes: MAX_LOGO_BYTES } });
}));

launcherCardRouter.put("/admin/v1/launcher-card", ...Owner, (req: Request, res: Response) => Wrap(res, async () => {
    const Text = CleanCardText(req.body);
    if (!Text) { res.status(400).json({ error: { code: "CARD_TEXT", message: `Title up to ${MAX_TITLE} characters, message up to ${MAX_MOTD}.` } }); return; }
    await Save(Text);
    await Audit(req, "launcher.card.update", Text);
    res.json(PublicCard(await Card()));
}));

launcherCardRouter.put("/admin/v1/launcher-card/logo", ...Owner,
    express.raw({ type: () => true, limit: MAX_LOGO_BYTES }),
    (req: Request, res: Response) => Wrap(res, async () => {
        const Data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const Type = LogoType(Data);
        if (!Type) { res.status(400).json({ error: { code: "CARD_LOGO", message: "Use a PNG, JPEG or WebP image up to 2 MB." } }); return; }
        await Save({ logo: Data, logoType: Type });
        await Audit(req, "launcher.card.logo", { type: Type, bytes: Data.length });
        res.json(PublicCard(await Card()));
    }));

launcherCardRouter.delete("/admin/v1/launcher-card/logo", ...Owner, (req: Request, res: Response) => Wrap(res, async () => {
    await Save({}, "logo");
    await Audit(req, "launcher.card.logo.remove", null);
    res.json(PublicCard(await Card()));
}));

// The invite for this server (launcher format, src/shared/invite.ts there) and its clickable https link.
// The host is whatever players reach this server at (a Tailscale address or a public name), so the owner
// names it; the fingerprint and the code come from this backend's own certificate and LAUNCHER_INVITE_CODES.
export const JOIN_PAGE = "https://hyjinnxdev.github.io/dauntless-revamped-releases/join/";

export function InviteFor(host: string, port: number, fp: string, code: string, name: string): { invite: string; link: string } {
    const Query = ["v=1", `host=${encodeURIComponent(host)}`, `port=${port}`, `fp=${fp}`, `code=${encodeURIComponent(code)}`, `name=${encodeURIComponent(name)}`].join("&");
    return { invite: `dauntless-revamped://join?${Query}`, link: `${JOIN_PAGE}#${Query}` };
}

launcherCardRouter.get("/admin/v1/launcher-card/invite", ...Owner, (req: Request, res: Response) => Wrap(res, async () => {
    const Host = String(req.query.host ?? "").trim().toLowerCase();
    const Port = Number(req.query.port ?? 443);
    if (!/^[a-z0-9.-]{1,253}$/.test(Host) || !Number.isInteger(Port) || Port < 1 || Port > 65535) {
        res.status(400).json({ error: { code: "CARD_HOST", message: "Enter the address players use, e.g. 100.108.36.34 or play.example.com." } });
        return;
    }
    const Code = (process.env.LAUNCHER_INVITE_CODES ?? "").split(",").map((c) => c.trim()).find((c) => /^[A-Za-z0-9-]{4,64}$/.test(c));
    if (!Code) { res.status(400).json({ error: { code: "CARD_CODE", message: "Set LAUNCHER_INVITE_CODES in the backend's .env first." } }); return; }
    const Pem = fs.readFileSync(process.env.PARADOX_CERT_PEM_PATH ?? "../ParadoxCertificates/paradox.mysticfox.dev-chain.pem", "utf8")
        .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    if (!Pem) { res.status(500).json({ error: { code: "CARD_CERT", message: "The backend's certificate file has no certificate." } }); return; }
    const Fp = new X509Certificate(Pem).fingerprint256.replace(/:/g, "").toLowerCase();
    const Name = (await Card()).doc?.title || "Dauntless server";
    res.json(InviteFor(Host, Port, Fp, Code, Name));
}));
