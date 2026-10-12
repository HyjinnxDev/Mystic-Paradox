/*
 * Copyright (C) 2026 Hyjinnx (Dauntless Forever)
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// [forever-launcher] Game files for the Dauntless Forever launcher (its "content contract"):
//   GET|HEAD /content/v1/manifest      the pinned file list (public; the launcher compares it with its own copy)
//   GET      /content/v1/files/<path>  one listed file, signed-in launcher accounts only, with Range resume
// GAME_CONTENT_MANIFEST is the JSON the launcher pins (scripts/make-game-manifest.mjs) and GAME_CONTENT_DIR the
// install it was made from. Either unset = no content routes (404), as before.

import fs from "node:fs";
import path from "node:path";
import express from "express";
import { HasLauncherAuth } from "../middleware/HasLauncherAuth";
import { logger } from "../logger";

interface ContentFile { path: string; size: number; sha256: string }

let Loaded: { raw: string; byPath: Map<string, ContentFile>; dir: string } | null | undefined;

// Read once; restart the backend after changing the manifest or the install.
function Content(): { raw: string; byPath: Map<string, ContentFile>; dir: string } | null {
    if (Loaded !== undefined) return Loaded;
    const ManifestPath = process.env.GAME_CONTENT_MANIFEST?.trim();
    const Dir = process.env.GAME_CONTENT_DIR?.trim();
    Loaded = null;
    if (!ManifestPath || !Dir) return Loaded;
    try {
        const Raw = fs.readFileSync(ManifestPath, "utf8");
        const Files = (JSON.parse(Raw) as { files: ContentFile[] }).files;
        Loaded = { raw: Raw, byPath: new Map(Files.map((f) => [f.path.toLowerCase(), f])), dir: path.resolve(Dir) };
        logger.info(`[Content] serving ${Files.length} game files from ${Loaded.dir}`);
    } catch (error) {
        logger.error(`[Content] manifest not loaded, content routes stay off: ${error}`);
    }
    return Loaded;
}

export const contentRouter = express.Router();

contentRouter.all("/content/v1/manifest", (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.status(405).send(); return; }
    const C = Content();
    if (!C) { res.status(404).send(); return; }
    res.type("application/json").send(C.raw);
});

const FILES_PREFIX = "/content/v1/files/";

contentRouter.get(/^\/content\/v1\/files\/.+$/, HasLauncherAuth, (req, res) => {
    const C = Content();
    if (!C) { res.status(404).send(); return; }
    let Rel: string;
    try {
        // req.path is still percent-encoded: decode each segment exactly once.
        Rel = req.path.slice(FILES_PREFIX.length).split("/").map(decodeURIComponent).join("/");
    } catch {
        res.status(400).send();
        return;
    }
    // Only exact manifest entries are served, so no request can name anything else on disk.
    const File = C.byPath.get(Rel.toLowerCase());
    if (!File) { res.status(404).send(); return; }
    // The launcher checks the strong ETag (its manifest SHA-256) and resumes with If-Range on it.
    res.setHeader("ETag", `"${File.sha256}"`);
    res.sendFile(path.join(C.dir, ...File.path.split("/")), { etag: false, lastModified: false, dotfiles: "allow", acceptRanges: true }, (error) => {
        if (error && !res.headersSent) res.status(404).send();
    });
});
