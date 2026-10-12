import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { IsValidInviteCode } from "./controllers/launcherAuth";

test("invite codes match only the configured list", () => {
    const Before = process.env.LAUNCHER_INVITE_CODES;
    try {
        delete process.env.LAUNCHER_INVITE_CODES;
        assert.equal(IsValidInviteCode("abcd-1234"), false, "no list = nothing valid");
        process.env.LAUNCHER_INVITE_CODES = " abcd-1234 , other ";
        assert.equal(IsValidInviteCode("abcd-1234"), true);
        assert.equal(IsValidInviteCode("other"), true);
        for (const bad of ["", "abcd-123", "ABCD-1234", undefined, 42, "x".repeat(200)]) {
            assert.equal(IsValidInviteCode(bad), false, String(bad));
        }
    } finally {
        if (Before === undefined) delete process.env.LAUNCHER_INVITE_CODES;
        else process.env.LAUNCHER_INVITE_CODES = Before;
    }
});

test("content routes: public manifest, files only for signed-in accounts", async () => {
    const Dir = fs.mkdtempSync(path.join(os.tmpdir(), "content-"));
    const Manifest = { build: "b", totalBytes: 3, files: [{ path: "Archon/a.txt", size: 3, sha256: "0".repeat(64) }] };
    fs.mkdirSync(path.join(Dir, "Archon"));
    fs.writeFileSync(path.join(Dir, "Archon", "a.txt"), "abc");
    fs.writeFileSync(path.join(Dir, "m.json"), JSON.stringify(Manifest));
    process.env.GAME_CONTENT_DIR = Dir;
    process.env.GAME_CONTENT_MANIFEST = path.join(Dir, "m.json");
    const { contentRouter } = await import("./routes/content");
    const App = express().use(contentRouter);
    const Server = App.listen(0);
    try {
        const Base = `http://127.0.0.1:${(Server.address() as { port: number }).port}`;
        const M = await fetch(`${Base}/content/v1/manifest`);
        assert.equal(M.status, 200);
        assert.deepEqual(await M.json(), Manifest);
        assert.equal((await fetch(`${Base}/content/v1/manifest`, { method: "HEAD" })).status, 200);
        // No launcher token: refused before anything is read from disk.
        assert.equal((await fetch(`${Base}/content/v1/files/Archon/a.txt`)).status, 401);
    } finally {
        Server.close();
        fs.rmSync(Dir, { recursive: true, force: true });
    }
});
