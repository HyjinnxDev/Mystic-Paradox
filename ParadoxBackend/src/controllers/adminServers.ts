// Staff dashboard: host/process metrics, game servers (via the Director's /api/admin), restarts,
// log tails and the per-player detail view. Windows-only process data (Get-CimInstance); the host
// numbers come from node:os and work anywhere.
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Request, Response } from "express";
import { logger } from "../logger";
import { GetRepositories, LauncherAccountRecord } from "../persistence";
import { GetMongoDb } from "../persistence/mongo/client";
import { Collections } from "../persistence/mongo/collections";
import { sessionRegistry } from "../realtime/SessionRegistry";
import { HasStaffPermission } from "../security/staffRoles";

const DIRECTOR = process.env.DEPLOYSERVER_URL;
// The key the Director's gameservers already use (Director METAGAME_API_KEY = first GAMESERVER_API_KEYS entry).
const DIRECTOR_KEY = (process.env.GAMESERVER_API_KEYS ?? "").split(",")[0].trim();
const LOG_DIR = process.env.ADMIN_LOG_DIR?.trim();
const RESTART_SCRIPT = process.env.ADMIN_RESTART_SCRIPT?.trim();
const MONGO_PORT = process.env.MONGODB_URI?.match(/:(\d+)(\/|\?|$)/)?.[1] ?? "27017";
const LOG_NAMES = ["backend", "director", "director-build", "restart"] as const;

// ---- Director ----

type DirectorServer = {
    id: string; kind: "ramsgate" | "dojo" | "hunt"; port: number; map: string; behemoth?: string;
    matchmakerHuntId?: string; expectedPlayers: string[]; processId: number; state: string;
    startTime: string; readyTime?: string;
};
type DirectorStatus = { directorPid: number; directorStartedAt: string; huntCap: number; servers: DirectorServer[] };

async function Director(pathAndQuery: string, method = "GET"): Promise<any> {
    const Res = await fetch(`http://${DIRECTOR}/api/admin${pathAndQuery}`, {
        method, headers: { "x-api-key": DIRECTOR_KEY }, signal: AbortSignal.timeout(4000)
    });
    const Body = await Res.json().catch(() => ({}));
    if (!Res.ok) throw new Error(Body.error ?? `Director answered ${Res.status}`);
    return Body;
}
async function DirectorStatus(): Promise<DirectorStatus | undefined> {
    try { return await Director("/gameservers"); } catch { return undefined; }
}

// ---- host + process metrics ----

function CpuTimes() {
    let Idle = 0, Total = 0;
    for (const C of os.cpus()) { Idle += C.times.idle; Total += C.times.user + C.times.nice + C.times.sys + C.times.idle + C.times.irq; }
    return { Idle, Total };
}
let LastCpu = CpuTimes();
function HostCpuPercent(): number {
    const Now = CpuTimes();
    const Total = Now.Total - LastCpu.Total, Idle = Now.Idle - LastCpu.Idle;
    LastCpu = Now;
    return Total > 0 ? Math.round(1000 * (1 - Idle / Total)) / 10 : 0;
}

type Sample = { t: number; cpu: number; mem: number; players: number; servers: number };
const History: Sample[] = [];
const HISTORY_MS = 24 * 3600_000;
let LastDirector: DirectorStatus | undefined;

async function TakeSample(): Promise<void> {
    LastDirector = await DirectorStatus();
    History.push({
        t: Date.now(),
        cpu: HostCpuPercent(),
        mem: Math.round(1000 * (1 - os.freemem() / os.totalmem())) / 10,
        players: sessionRegistry.onlineAccountCount(),
        servers: LastDirector?.servers.length ?? 0
    });
    while (History.length > 0 && History[0].t < Date.now() - HISTORY_MS) History.shift();
    if (LOG_DIR) {
        const S = History[History.length - 1], File = path.join(LOG_DIR, "host-metrics.csv");
        const Head = fs.existsSync(File) ? "" : "time,cpuPct,memPct,memUsedMB,players,servers\n";
        const UsedMB = Math.round((os.totalmem() - os.freemem()) / 1048576);
        await fs.promises.appendFile(File, `${Head}${new Date(S.t).toISOString()},${S.cpu},${S.mem},${UsedMB},${S.players},${S.servers}\n`);
    }
}
// ponytail: in-memory 24h history at 15 s for the dashboard; host-metrics.csv in ADMIN_LOG_DIR keeps the full record (grows ~5 MB/month, no rotation).
setInterval(() => { void TakeSample().catch(() => {}); }, 15_000).unref();

function Downsample(minutes: number, points = 240): Sample[] {
    const Since = Date.now() - minutes * 60_000;
    const Rows = History.filter((S) => S.t >= Since);
    const Step = Math.max(1, Math.ceil(Rows.length / points));
    const Out: Sample[] = [];
    for (let I = 0; I < Rows.length; I += Step) {
        const B = Rows.slice(I, I + Step);
        const Avg = (K: keyof Sample) => Math.round(10 * B.reduce((A, S) => A + S[K], 0) / B.length) / 10;
        Out.push({ t: B[B.length - 1].t, cpu: Avg("cpu"), mem: Avg("mem"), players: Math.max(...B.map((S) => S.players)), servers: Avg("servers") });
    }
    return Out;
}

type RawProc = { p: number; pp: number; n: string; c: string | null; m: number; t: number; s: string };
const LastProcCpu = new Map<number, { t: number; at: number }>();
let ProcCache: { at: number; procs: RawProc[] } | undefined;

function ListProcesses(): Promise<RawProc[]> {
    if (process.platform !== "win32") return Promise.resolve([]);
    if (ProcCache && Date.now() - ProcCache.at < 4000) return Promise.resolve(ProcCache.procs);
    const Script = "$x=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='mongod.exe' OR Name='Dauntless-Win64-Shipping.exe'\" | " +
        "ForEach-Object { [pscustomobject]@{p=$_.ProcessId;pp=$_.ParentProcessId;n=$_.Name;c=$_.CommandLine;m=$_.WorkingSetSize;t=$_.KernelModeTime+$_.UserModeTime;s=$_.CreationDate.ToString('o')} }); " +
        "ConvertTo-Json -Compress -InputObject $x";
    return new Promise((resolve) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", Script], { windowsHide: true, timeout: 8000, maxBuffer: 4 << 20 }, (Err, Out) => {
            let Procs: RawProc[] = [];
            try { if (!Err) Procs = JSON.parse(Out) ?? []; } catch { /* empty list */ }
            ProcCache = { at: Date.now(), procs: Procs };
            resolve(Procs);
        });
    });
}
function ProcCpuPercent(P: RawProc): number | undefined {
    const Prev = LastProcCpu.get(P.p), Now = Date.now();
    LastProcCpu.set(P.p, { t: P.t, at: Now });
    if (!Prev || Now <= Prev.at) return undefined;
    // Kernel+User time is in 100 ns units; % of the whole machine like Task Manager.
    return Math.round(1000 * ((P.t - Prev.t) / 1e4) / ((Now - Prev.at) * os.cpus().length)) / 10;
}

let Elevated: boolean | undefined;
function IsElevated(): Promise<boolean> {
    if (Elevated !== undefined || process.platform !== "win32") return Promise.resolve(Elevated ?? false);
    return new Promise((resolve) => execFile("net", ["session"], { windowsHide: true }, (Err) => resolve(Elevated = !Err)));
}

function Disk() {
    try {
        const S = fs.statfsSync(path.parse(LOG_DIR ?? process.cwd()).root);
        return { path: path.parse(LOG_DIR ?? process.cwd()).root, total: S.blocks * S.bsize, free: S.bavail * S.bsize };
    } catch { return undefined; }
}

export async function GetServersOverview(_req: Request, res: Response): Promise<void> {
    const [Dir, Procs, Elev] = await Promise.all([DirectorStatus(), ListProcesses(), IsElevated()]);
    LastDirector = Dir;
    const ByPid = new Map(Dir?.servers.map((S) => [S.processId, S]) ?? []);
    const Processes = Procs.flatMap((P) => {
        let Role: string | undefined;
        if (P.p === process.pid) Role = "backend";
        else if (P.p === Dir?.directorPid) Role = "director";
        else if (P.n === "mongod.exe" && new RegExp(`--port\\s+${MONGO_PORT}\\b`).test(P.c ?? "")) Role = "mongodb";
        else if (ByPid.has(P.p)) Role = "gameserver";
        if (!Role) return []; // other node/game processes on the box (other stacks, clients)
        return [{ pid: P.p, role: Role,
            gameserverId: ByPid.get(P.p)?.id, memory: P.m, cpu: ProcCpuPercent(P), startedAt: P.s }];
    });
    const Db = await GetMongoDb();
    const DayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    const [Accounts, New24h, Pending, Banned] = await Promise.all([
        Db.collection(Collections.Accounts).countDocuments({ userId: { $exists: true } }),
        Db.collection(Collections.Accounts).countDocuments({ createdAt: { $gte: DayAgo } }),
        Db.collection(Collections.Accounts).countDocuments({ approvalStatus: "pending" }),
        Db.collection(Collections.Accounts).countDocuments({ status: "banned", $or: [{ bannedUntil: null }, { bannedUntil: { $exists: false } }, { bannedUntil: { $gt: new Date().toISOString() } }] })
    ]);
    res.json({
        observedAt: new Date().toISOString(),
        host: {
            hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, cpuModel: os.cpus()[0]?.model, cores: os.cpus().length,
            cpu: History.at(-1)?.cpu ?? HostCpuPercent(), memTotal: os.totalmem(), memFree: os.freemem(),
            uptime: os.uptime(), disk: Disk()
        },
        backend: { pid: process.pid, uptime: process.uptime(), node: process.version, memory: process.memoryUsage().rss },
        director: Dir ? { reachable: true, pid: Dir.directorPid, startedAt: Dir.directorStartedAt, huntCap: Dir.huntCap } : { reachable: false },
        gameservers: Dir?.servers ?? [],
        processes: Processes,
        players: { online: sessionRegistry.onlineAccountCount(), accounts: Accounts, new24h: New24h, pending: Pending, banned: Banned },
        control: {
            restart: Boolean(RESTART_SCRIPT) && Elev,
            restartWhyNot: !RESTART_SCRIPT ? "ADMIN_RESTART_SCRIPT is not set in the backend .env."
                : !Elev ? "The backend isn't running elevated, so the restart script would stop at a UAC prompt. Start it with restart-server.ps1." : undefined,
            logs: Boolean(LOG_DIR)
        }
    });
}

export function GetServersHistory(req: Request, res: Response): void {
    const Minutes = Math.min(24 * 60, Math.max(5, Number(req.query.minutes) || 60));
    res.json({ samples: Downsample(Minutes) });
}

async function Audit(req: Request, action: string, state: Record<string, unknown>, reason: string): Promise<void> {
    await GetRepositories().admin.appendAudit({
        id: crypto.randomUUID(), actorUserId: ((req as any).AdminAuth.account as LauncherAccountRecord).userId,
        action, oldState: {}, newState: state, reason, ip: req.ip ?? "unknown",
        requestId: crypto.randomUUID(), createdAt: new Date().toISOString()
    });
}
function ReadReason(req: Request, res: Response): string | undefined {
    const Reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";
    if (Reason.length < 3) { res.status(400).json({ error: { code: "ADMIN_VALIDATION", message: "Give a reason (3+ characters) for the audit log." } }); return undefined; }
    return Reason;
}

export async function StopGameserver(req: Request, res: Response): Promise<void> {
    const Reason = ReadReason(req, res);
    if (Reason == undefined) return;
    const Id = String(req.params.id);
    const Server = (await DirectorStatus())?.servers.find((S) => S.id === Id);
    if (!Server) { res.status(404).json({ error: { code: "NOT_FOUND", message: "That server is gone already." } }); return; }
    try { await Director(`/gameservers/${encodeURIComponent(Id)}/stop`, "POST"); } catch (error) {
        res.status(502).json({ error: { code: "DIRECTOR", message: (error as Error).message } });
        return;
    }
    await Audit(req, "server.gameserver.stop", { kind: Server.kind, map: Server.map, port: Server.port }, Reason);
    res.json({ ok: true });
}

export async function GetGameserverLog(req: Request, res: Response): Promise<void> {
    try { res.json(await Director(`/gameservers/${encodeURIComponent(String(req.params.id))}/log`)); } catch (error) {
        res.status(502).json({ error: { code: "DIRECTOR", message: (error as Error).message } });
    }
}

export async function RestartStack(req: Request, res: Response): Promise<void> {
    const Target = req.body?.target;
    if (Target !== "stack" && Target !== "director") { res.status(400).json({ error: { code: "ADMIN_VALIDATION", message: "target must be stack or director." } }); return; }
    const Reason = ReadReason(req, res);
    if (Reason == undefined) return;
    if (!RESTART_SCRIPT || !(await IsElevated())) { res.status(409).json({ error: { code: "ADMIN_RESTART_UNAVAILABLE", message: "Restart isn't available on this host (see the Servers page)." } }); return; }
    await Audit(req, `server.restart.${Target}`, { target: Target }, Reason);
    logger.warn(`[ADMIN] ${Target} restart requested from the dashboard: ${Reason}`);
    res.json({ ok: true });
    // Detached so the script outlives this process (a stack restart stops the backend itself).
    setTimeout(() => {
        const Out = fs.openSync(path.join(LOG_DIR ?? os.tmpdir(), "restart.log"), "a");
        spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RESTART_SCRIPT, ...(Target === "director" ? ["-DirectorOnly"] : [])],
            { detached: true, windowsHide: true, stdio: ["ignore", Out, Out] }).unref();
    }, 500);
}

/** Last `bytes` of a file, from a line boundary. */
function TailFile(file: string, bytes = 256 * 1024): string {
    const Fd = fs.openSync(file, "r");
    try {
        const Size = fs.fstatSync(Fd).size, Start = Math.max(0, Size - bytes);
        const Buf = Buffer.alloc(Size - Start);
        fs.readSync(Fd, Buf, 0, Buf.length, Start);
        const Text = Buf.toString("utf8");
        return Start > 0 ? Text.slice(Text.indexOf("\n") + 1) : Text;
    } finally { fs.closeSync(Fd); }
}

export function GetLog(req: Request, res: Response): void {
    const Name = String(req.params.name);
    if (!LOG_DIR || !(LOG_NAMES as readonly string[]).includes(Name)) { res.status(404).json({ error: { code: "NOT_FOUND", message: "Unknown log." } }); return; }
    try { res.json({ text: TailFile(path.join(LOG_DIR, `${Name}.log`)) }); } catch (error) {
        res.json({ text: `(log unavailable: ${(error as Error).message})` });
    }
}

// ---- players ----

export async function ListOnlinePlayersDetailed(req: Request, res: Response): Promise<void> {
    const ShowIp = HasStaffPermission((req as any).AdminAuth.account.roles, "players.access");
    const Ids = sessionRegistry.onlineAccountIds();
    const [Docs, Dir] = await Promise.all([
        (await GetMongoDb()).collection(Collections.Accounts).find({ _id: { $in: Ids as any[] } })
            .project({ displayName: 1, roles: 1, lastSeenAt: 1, lastSeenIp: 1 }).toArray(),
        DirectorStatus()
    ]);
    const Players = Docs.map((D) => ({
        userId: String(D._id), displayName: D.displayName, roles: D.roles ?? [], onlineSince: D.lastSeenAt,
        ip: ShowIp ? D.lastSeenIp : undefined, server: ServerFor(Dir, String(D._id))
    })).sort((A, B) => A.displayName.localeCompare(B.displayName, undefined, { sensitivity: "base" }));
    res.json({ count: Players.length, players: Players });
}

function ServerFor(Dir: DirectorStatus | undefined, ...Ids: string[]) {
    const S = Dir?.servers.find((X) => X.kind === "hunt" && X.expectedPlayers.some((P) => Ids.includes(P)));
    return S ? { id: S.id, map: S.map, behemoth: S.behemoth, port: S.port } : undefined;
}

export async function GetPlayerDetail(req: Request, res: Response): Promise<void> {
    const UserId = String(req.params.userId);
    const IsAdmin = HasStaffPermission((req as any).AdminAuth.account.roles, "players.access");
    const Db = await GetMongoDb();
    const Account = await Db.collection(Collections.Accounts).findOne({ _id: UserId as any });
    if (!Account) { res.status(404).json({ error: { code: "NOT_FOUND", message: "Player not found." } }); return; }
    const [Characters, Wallet, Guild, Friends, Entitlements, Tracks, Sessions, Dir] = await Promise.all([
        Db.collection(Collections.Characters).find({ userId: UserId }).project({ characterId: 1, name: 1, createdDate: 1, lastModifiedDate: 1 }).toArray(),
        Db.collection(Collections.Wallets).findOne({ _id: UserId as any }),
        Db.collection(Collections.GuildMembers).findOne({ _id: UserId as any }),
        Db.collection(Collections.Friendships).countDocuments({ ownerId: UserId, status: "ACCEPTED" }),
        Db.collection(Collections.Entitlements).findOne({ _id: UserId as any }),
        Db.collection(Collections.ProgressionTracks).find({ userId: UserId }).project({ progressionId: 1, confirmedFremiumRank: 1, confirmedPremiumRank: 1, progress: 1, updatedAt: 1 }).toArray(),
        IsAdmin ? Db.collection(Collections.RefreshSessions).find({ userId: UserId }).project({ deviceName: 1, createdAt: 1, expiresAt: 1, revokedAt: 1 }).sort({ createdAt: -1 }).limit(20).toArray() : [],
        DirectorStatus()
    ]);
    const GuildDoc = Guild ? await Db.collection(Collections.Guilds).findOne({ _id: Guild.guildId }) : null;
    const SameIp = IsAdmin && Account.lastSeenIp
        ? await Db.collection(Collections.Accounts).find({ lastSeenIp: Account.lastSeenIp, _id: { $ne: UserId as any } }).project({ displayName: 1 }).limit(20).toArray()
        : [];
    const Online = sessionRegistry.isOnline(UserId);
    res.json({
        online: Online,
        lastSeenAt: Account.lastSeenAt,
        lastSeenIp: IsAdmin ? Account.lastSeenIp : undefined,
        server: Online ? ServerFor(Dir, UserId, ...Characters.map((C) => String(C._id))) : undefined,
        characters: Characters.map((C) => ({ characterId: String(C._id), name: C.name, created: C.createdDate, modified: C.lastModifiedDate })),
        wallet: Wallet?.balances ?? {},
        guild: Guild ? { name: GuildDoc?.name, tag: GuildDoc?.nameplate, rank: Guild.rank, joinedAt: Guild.joinedAt } : undefined,
        friends: Friends,
        entitlements: (Entitlements?.entitlements ?? []).map((E: any) => E.name),
        progression: Tracks.map((T) => ({ id: T.progressionId, rank: T.confirmedFremiumRank, premiumRank: T.confirmedPremiumRank, progress: T.progress, updatedAt: T.updatedAt })),
        devices: Sessions.map((S) => ({ name: S.deviceName, createdAt: S.createdAt, expiresAt: S.expiresAt, revokedAt: S.revokedAt })),
        sameIp: SameIp.map((A) => ({ userId: String(A._id), displayName: A.displayName }))
    });
}
