// Read/stop endpoints for the backend's staff dashboard (ParadoxBackend controllers/adminServers.ts).
// Every call needs the METAGAME_API_KEY the backend already shares with this Director.
import crypto from "node:crypto";
import fs from "node:fs";
import { Router } from "express";
import { logger } from "../logger";
import { Gameservers, MAX_CONCURRENT_HUNT_SERVERS } from "../controllers/gameservers";

export const adminRouter = Router();

adminRouter.use((req, res, next) => {
    const Expected = process.env.METAGAME_API_KEY ?? "";
    const Given = String(req.headers["x-api-key"] ?? "");
    const Ok = Expected.length > 0 && Given.length === Expected.length
        && crypto.timingSafeEqual(Buffer.from(Given), Buffer.from(Expected));
    if (!Ok) { res.status(401).json({ error: "unauthorized" }); return; }
    next();
});

adminRouter.get("/gameservers", (_req, res) => {
    res.json({
        directorPid: process.pid,
        directorStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        huntCap: MAX_CONCURRENT_HUNT_SERVERS,
        servers: Gameservers.map((S) => ({
            id: S.id,
            kind: S.isRamsgate ? "ramsgate" : S.isTrainingDojo ? "dojo" : "hunt",
            port: S.port,
            map: S.map,
            behemoth: S.behemoth,
            matchmakerHuntId: S.matchmakerHuntId,
            expectedPlayers: (S.expectedPlayers ?? []).map((P) => P.playerUid),
            processId: S.processId,
            state: S.state,
            startTime: S.startTime,
            readyTime: S.readyTime
        }))
    });
});

// Kills the process. The normal exit path does the rest: hubs are restarted by their supervisor,
// a hunt's port is released and its players drop back to Ramsgate.
adminRouter.post("/gameservers/:id/stop", (req, res) => {
    const Server = Gameservers.find((S) => S.id === req.params.id);
    if (!Server) { res.status(404).json({ error: "not_found" }); return; }
    logger.warn(`[Admin] stopping gameserver port=${Server.port} pid=${Server.processId} map=${Server.map} (dashboard)`);
    try { process.kill(Server.processId); } catch (error) {
        res.status(409).json({ error: `kill failed: ${(error as Error).message}` });
        return;
    }
    res.json({ ok: true });
});

adminRouter.get("/gameservers/:id/log", (req, res) => {
    const Server = Gameservers.find((S) => S.id === req.params.id);
    if (!Server) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ text: TailFile(Server.logPath, 256 * 1024) });
});

/** Last `bytes` of a file, starting at a line boundary. */
function TailFile(file: string, bytes: number): string {
    try {
        const Fd = fs.openSync(file, "r");
        try {
            const Size = fs.fstatSync(Fd).size;
            const Start = Math.max(0, Size - bytes);
            const Buf = Buffer.alloc(Size - Start);
            fs.readSync(Fd, Buf, 0, Buf.length, Start);
            const Text = Buf.toString("utf8");
            return Start > 0 ? Text.slice(Text.indexOf("\n") + 1) : Text;
        } finally { fs.closeSync(Fd); }
    } catch (error) {
        return `(log unavailable: ${(error as Error).message})`;
    }
}
