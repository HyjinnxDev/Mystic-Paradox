import crypto from "node:crypto";
import { logger } from "../logger";
import { GetRepositories } from "../persistence";
import { GetMongoDb } from "../persistence/mongo/client";
import { Collections } from "../persistence/mongo/collections";

// Guilds for the 1.14.7 client (guild-prod.steelyard.ca), ported from the 1.4.4 UndauntedMetagame
// (dauntless-revived controllers/guild.ts). The 1.14.7 exe carries the same eleven *_v2 endpoint keys
// and the same EGuildRequestError set, so the contract and codes are reused unchanged.
//
// - Replies use the Phoenix envelope {code, message, payload}; a guild or invite list is also copied flat
//   to the root. On an error status the client maps "code" to EGuildRequestError.
// - Create arrives either from the Ramsgate server with the game-server key (the Create button is an RPC
//   on 1.4.4) or straight from the client with its own token. A game-server create is only accepted when
//   the leader validated that same name/nameplate with their own token in the last 15 minutes.
// - Storage: guilds (_id guildId), guildMembers (_id accountId, so one guild per account is enforced by
//   Mongo), guildInvites (_id inviteId, removed by the expiresAt TTL index). Unique indexes on the
//   lowercase name and nameplate (persistence/mongo/indexes.ts).
// ponytail: no transactions; the member cap can overshoot by a racing accept or two. Wrap in
// GetUnitOfWork().withTransaction if that ever matters.
// - Members and invitees see changes at their next GET /guild or GET /guild/invite/player: no push.

export const GUILD_CODE = {
    InvalidPermission: "SlyAdorableQuillshot",
    NotInAGuild: "ExcludedAdorableQuillshot",
    NameInvalidLength: "ObedientAdorableQuillshot",
    NameTaken: "SeizedAdorableQuillshot",
    NameProfane: "NastyAdorableQuillshot",
    NameTooManyNumbers: "NumberedAdorableQuillshot",
    NameTooManyLetters: "LetteredAdorableQuillshot",
    NameplateInvalidLength: "DutifulAdorableQuillshot",
    NameplateTaken: "CapturedAdorableQuillshot",
    NameplateProfane: "DirtyAdorableQuillshot",
    AlreadyInAGuild: "OccupiedAdorableQuillshot",
    TargetAlreadyInYourGuild: "ClonedAdorableQuillshot",
    TargetAlreadyHasGuildInvite: "RedundantAdorableQuillshot",
    GuildIsFull: "StuffedAdorableQuillshot",
    InviteNotFound: "UninvitedAdorableQuillshot",
    LeaderCannotLeave: "ChiefAdorableQuillshot",
    InvalidRank: "DocileAdorableQuillshot",
    Unknown: ""
} as const;

type GuildCode = typeof GUILD_CODE[keyof typeof GUILD_CODE];

const MESSAGES: Record<string, string> = {
    [GUILD_CODE.InvalidPermission]: "You do not have permission to do that.",
    [GUILD_CODE.NotInAGuild]: "Not in that guild.",
    [GUILD_CODE.NameInvalidLength]: "Name is invalid. Must contain 4-15 english letters and digits.",
    [GUILD_CODE.NameTaken]: "Guild name already in use.",
    [GUILD_CODE.NameProfane]: "Guild name contains profanity.",
    [GUILD_CODE.NameTooManyNumbers]: "Guild name must have 6 numbers or less.",
    [GUILD_CODE.NameTooManyLetters]: "Guild name must not have more than 6 of the same letter in a row.",
    [GUILD_CODE.NameplateInvalidLength]: "Nameplate is invalid. Must contain 2-6 english letters and digits.",
    [GUILD_CODE.NameplateTaken]: "Guild nameplate already in use.",
    [GUILD_CODE.NameplateProfane]: "Guild nameplate contains profanity.",
    [GUILD_CODE.AlreadyInAGuild]: "Unable to create guild. You are already in a guild.",
    [GUILD_CODE.TargetAlreadyInYourGuild]: "That player is already in your guild.",
    [GUILD_CODE.TargetAlreadyHasGuildInvite]: "That player already has an invite from your guild.",
    [GUILD_CODE.GuildIsFull]: "The guild is full.",
    [GUILD_CODE.InviteNotFound]: "Guild invite not found.",
    [GUILD_CODE.LeaderCannotLeave]: "The guild leader cannot leave the guild.",
    [GUILD_CODE.InvalidRank]: "Invalid guild rank."
};

const MAX_OPEN_INVITES_PER_GUILD = 50;
const MAX_OPEN_INVITES_PER_INVITEE = 20;
const MAX_INVITES_PER_INVITER_PER_HOUR = 30;
const CREATE_INTERVAL_MS = 10 * 60 * 1000;
const VALIDATE_TICKET_MS = 15 * 60 * 1000;
const MAX_TICKETS_PER_ACCOUNT = 5;
const DECLINE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

type GuildRank = "Member" | "Officer" | "Leader";
type GuildDoc = { _id: string, name: string, nameKey: string, nameplate: string, nameplateKey?: string, leaderId: string, createdAt: Date };
type MemberDoc = { _id: string, guildId: string, rank: GuildRank, joinedAt: Date };
type InviteDoc = { _id: string, guildId: string, inviteeId: string, inviterId: string, createdAt: Date, expiresAt: Date };

export type GuildReply = { Status: number, Body: unknown, Code?: GuildCode };

function MaxGuildMembers(){
    const Value = Number(process.env.GUILD_MAX_MEMBERS);
    return Number.isInteger(Value) && Value >= 1 && Value <= 10000 ? Value : 100;
}

function InviteTtlMs(){
    const Value = Number(process.env.GUILD_INVITE_TTL_DAYS);
    return (Number.isFinite(Value) && Value > 0 && Value <= 365 ? Value : 7) * 24 * HOUR_MS;
}

// ---- In memory (losing these on a restart is harmless) ----

type Ticket = { NameKey: string, NameplateKey: string, At: number };
const Tickets = new Map<string, Ticket[]>();
const LastCreated = new Map<string, number>();
const InvitesSent = new Map<string, number[]>();
const Declined = new Map<string, number>(); // "<guildId>|<inviteeId>" -> declined at

function LiveTickets(Account: string, Now: number){
    return (Tickets.get(Account) ?? []).filter((T) => Now - T.At <= VALIDATE_TICKET_MS);
}

function RecentInvitesBy(Account: string, Now: number){
    return (InvitesSent.get(Account) ?? []).filter((At) => Now - At < HOUR_MS);
}

// ---- Replies ----

function Envelope(Payload: object){
    return { code: "OK", message: "", payload: Payload };
}

function Ack(): GuildReply {
    return { Status: 200, Body: Envelope({}) };
}

function WithPayload(Payload: Record<string, unknown>): GuildReply {
    return { Status: 200, Body: { ...Envelope(Payload), ...Payload } };
}

function Refuse(Status: number, Code: GuildCode, Message?: string): GuildReply {
    return { Status, Body: { code: Code, message: Message ?? MESSAGES[Code] ?? "", payload: {} }, Code };
}

function Describe(Reply: GuildReply){
    return Reply.Status < 300 ? `${Reply.Status}` : `${Reply.Status} ${Reply.Code === "" ? "(no code)" : Reply.Code}`;
}

function Quoted(Value: unknown){
    return typeof Value === "string" ? JSON.stringify(Value.slice(0, 32)) : `<${typeof Value}>`;
}

export function IsAccountIdShape(Value: unknown): Value is string {
    return typeof Value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(Value);
}

function Shown(Value: unknown){
    return IsAccountIdShape(Value) ? Value : "<not an account id>";
}

// ---- Names and nameplates (pure; tested in guild.test.ts) ----

const NAME_RULE = /^[A-Za-z0-9]{4,15}$/;
const NAMEPLATE_RULE = /^[A-Za-z0-9]{2,6}$/;

const DENYLIST = [
    "fuck", "shit", "cunt", "bitch", "whore", "slut", "nigger", "nigga", "faggot", "retard",
    "nazi", "hitler", "penis", "vagina", "pussy", "dildo", "twat", "wank", "porn", "kike"
];
const OFFENSIVE_WHOLE = ["kkk", "fag", "fags", "nig", "nigs", "fck", "fuk", "rape", "isis", "ss", "1488", "hh88"];
// Words that would let a guild pose as staff or the project; GUILD_RESERVED_NAMES=0 turns them off
const RESERVED_ANYWHERE = ["admin", "moderator", "official", "gamemaster", "staff", "dauntlessrevived", "phoenixlabs", "mysticparadox"];
const RESERVED_WHOLE_NAME = ["dauntless", "phoenix", "revived", "support", "system", "server", "servers", "mods", "developer", "developers", "devteam"];
const RESERVED_WHOLE_NAMEPLATE = ["gm", "gms", "dev", "devs", "mod", "mods", "sys", "phx", "dr", "drev", "undt"];

function Unleet(Text: string){
    return Text.toLowerCase().replace(/[013457]/g, (D) => ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" } as Record<string, string>)[D]);
}

function IsProfane(Text: string){
    const Lower = Text.toLowerCase();
    const Plain = Unleet(Text);
    const Extra = (process.env.GUILD_NAME_DENYLIST ?? "").split(",").map((W) => Unleet(W.trim())).filter((W) => /^[a-z0-9]{2,32}$/.test(W));
    return [...DENYLIST, ...Extra, "kkk"].some((W) => Plain.includes(W)) || OFFENSIVE_WHOLE.includes(Lower) || OFFENSIVE_WHOLE.includes(Plain);
}

function IsReserved(Text: string, IsNameplate: boolean){
    if(process.env.GUILD_RESERVED_NAMES === "0") return false;
    const Whole = IsNameplate ? RESERVED_WHOLE_NAMEPLATE : RESERVED_WHOLE_NAME;
    return [Text.toLowerCase(), Unleet(Text)].some((F) => RESERVED_ANYWHERE.some((W) => F.includes(W)) || Whole.includes(F));
}

function LongestRun(Text: string){
    const Lower = Text.toLowerCase();
    let Longest = 0, Run = 0;
    for(let I = 0; I < Lower.length; I++){
        Run = I > 0 && Lower[I] === Lower[I - 1] ? Run + 1 : 1;
        Longest = Math.max(Longest, Run);
    }
    return Longest;
}

function PlateOf(Nameplate: unknown){
    return Nameplate === undefined || Nameplate === null ? "" : Nameplate;
}

export function CheckNameRules(Name: unknown): GuildReply | undefined {
    if(typeof Name !== "string" || !NAME_RULE.test(Name)) return Refuse(400, GUILD_CODE.NameInvalidLength);
    if((Name.match(/[0-9]/g) ?? []).length > 6) return Refuse(400, GUILD_CODE.NameTooManyNumbers);
    if(LongestRun(Name) > 6) return Refuse(400, GUILD_CODE.NameTooManyLetters);
    if(IsProfane(Name)) return Refuse(400, GUILD_CODE.NameProfane);
    if(IsReserved(Name, false)) return Refuse(409, GUILD_CODE.NameTaken);
    return undefined;
}

// An empty nameplate is allowed (the client skips it when empty)
export function CheckNameplateRules(Nameplate: unknown): GuildReply | undefined {
    const Plate = PlateOf(Nameplate);
    if(typeof Plate !== "string" || (Plate.length > 0 && !NAMEPLATE_RULE.test(Plate))) return Refuse(400, GUILD_CODE.NameplateInvalidLength);
    if(Plate.length === 0) return undefined;
    if(IsProfane(Plate)) return Refuse(400, GUILD_CODE.NameplateProfane);
    if(IsReserved(Plate, true)) return Refuse(409, GUILD_CODE.NameplateTaken);
    return undefined;
}

export function NormalizeRank(Rank: unknown): GuildRank | undefined {
    switch(typeof Rank === "string" ? Rank.toLowerCase() : ""){
        case "member": return "Member";
        case "officer": return "Officer";
        case "leader": return "Leader";
        default: return undefined;
    }
}

// ---- Database ----

async function Cols(){
    const Db = await GetMongoDb();
    return {
        Guilds: Db.collection<GuildDoc>(Collections.Guilds),
        Members: Db.collection<MemberDoc>(Collections.GuildMembers),
        Invites: Db.collection<InviteDoc>(Collections.GuildInvites)
    };
}

type C = Awaited<ReturnType<typeof Cols>>;

function IsDuplicateKey(error: any){
    return error?.code === 11000;
}

async function MembershipOf(C: C, AccountId: string){
    return (await C.Members.findOne({ _id: AccountId })) ?? undefined;
}

async function AccountExists(AccountId: string){
    return (await GetRepositories().accounts.findByUserId(AccountId)) !== undefined;
}

async function IsBlockedEitherWay(A: string, B: string){
    const Friends = GetRepositories().friendships;
    const [AB, BA] = await Promise.all([Friends.find(A, B), Friends.find(B, A)]);
    return AB?.status === "BLOCKED" || BA?.status === "BLOCKED";
}

async function InviterStillMayInvite(C: C, InviterId: string, GuildId: string){
    const M = await MembershipOf(C, InviterId);
    return M !== undefined && M.guildId === GuildId && (M.rank === "Leader" || M.rank === "Officer");
}

const RANK_ORDER: Record<string, number> = { Leader: 0, Officer: 1, Member: 2 };

async function GuildData(C: C, GuildId: string){
    const Row = await C.Guilds.findOne({ _id: GuildId });
    if(Row === null) return undefined;

    const Members = (await C.Members.find({ guildId: GuildId }).toArray())
        .sort((A, B) => (RANK_ORDER[A.rank] ?? 3) - (RANK_ORDER[B.rank] ?? 3) || +A.joinedAt - +B.joinedAt || A._id.localeCompare(B._id));

    return {
        id: Row._id,
        name: Row.name,
        nameplate: Row.nameplate,
        leader_account_id: Row.leaderId,
        members: Members.map((M) => ({ phx_account_id: M._id, rank: M.rank })),
        maximum_guild_members: Math.max(MaxGuildMembers(), Members.length)
    };
}

// The name and nameplate rules plus "taken", in the order the first failure decides
async function CheckNameAndNameplate(C: C, Name: unknown, Nameplate: unknown): Promise<GuildReply | { Name: string, NameKey: string, Plate: string, PlateKey?: string }> {
    const NameRefusal = CheckNameRules(Name);
    if(NameRefusal) return NameRefusal;

    const NameKey = (Name as string).toLowerCase();
    if(await C.Guilds.findOne({ nameKey: NameKey }, { projection: { _id: 1 } })) return Refuse(409, GUILD_CODE.NameTaken);

    const PlateRefusal = CheckNameplateRules(Nameplate);
    if(PlateRefusal) return PlateRefusal;

    const Plate = PlateOf(Nameplate) as string;
    if(Plate.length === 0) return { Name: Name as string, NameKey, Plate };

    const PlateKey = Plate.toLowerCase();
    if(await C.Guilds.findOne({ nameplateKey: PlateKey }, { projection: { _id: 1 } })) return Refuse(409, GUILD_CODE.NameplateTaken);

    return { Name: Name as string, NameKey, Plate, PlateKey };
}

function IsReply(Value: object): Value is GuildReply {
    return (Value as GuildReply).Status !== undefined;
}

// ---- Reading ----

// GET /guild: the caller's guild, or 204 when there is none (the client then clears its guild)
export async function GetOwnGuild(UserId: string): Promise<GuildReply> {
    const C = await Cols();
    const M = await MembershipOf(C, UserId);
    const Data = M === undefined ? undefined : await GuildData(C, M.guildId);
    return Data === undefined ? { Status: 204, Body: undefined } : WithPayload(Data);
}

// GET /guild/invite/player: open invites, newest first; blocked pairs and inviters who lost the right are left out
export async function ListOwnGuildInvites(UserId: string): Promise<GuildReply> {
    const C = await Cols();
    const Rows = await C.Invites.find({ inviteeId: UserId, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1, _id: 1 }).toArray();
    const Invites = [];

    for(const Row of Rows){
        const Guild = await C.Guilds.findOne({ _id: Row.guildId }, { projection: { name: 1 } });
        if(Guild === null || await IsBlockedEitherWay(UserId, Row.inviterId) || !(await InviterStillMayInvite(C, Row.inviterId, Row.guildId))) continue;
        Invites.push({ id: Row._id, guild_id: Row.guildId, guild_name: Guild.name, inviter_account_id: Row.inviterId });
    }

    return WithPayload({ invites: Invites });
}

// ---- Creating ----

// POST /guild/validate {leader_account_id, name, nameplate}: checked while the player types
export async function ValidateGuildCreate(UserId: string, Name: unknown, Nameplate: unknown): Promise<GuildReply> {
    const C = await Cols();
    const Now = Date.now();
    const Result = (await MembershipOf(C, UserId)) !== undefined ? Refuse(409, GUILD_CODE.AlreadyInAGuild) : await CheckNameAndNameplate(C, Name, Nameplate);

    if(IsReply(Result)){
        logger.info(`guild: validate by ${UserId} name=${Quoted(Name)} tag=${Quoted(Nameplate ?? "")} -> ${Describe(Result)}`);
        return Result;
    }

    const Keys = { NameKey: Result.NameKey, NameplateKey: Result.PlateKey ?? "" };
    const Kept = LiveTickets(UserId, Now).filter((T) => T.NameKey !== Keys.NameKey || T.NameplateKey !== Keys.NameplateKey);
    Tickets.set(UserId, [...Kept, { ...Keys, At: Now }].slice(-MAX_TICKETS_PER_ACCOUNT));
    logger.info(`guild: validate by ${UserId} name=${Quoted(Name)} tag=${Quoted(Nameplate ?? "")} -> ok`);
    return Ack();
}

function HasTicket(Leader: string, Name: unknown, Nameplate: unknown, Now: number){
    const Plate = PlateOf(Nameplate);
    if(typeof Name !== "string" || typeof Plate !== "string") return false;
    const Live = LiveTickets(Leader, Now);
    if(Live.some((T) => T.NameKey === Name.toLowerCase() && T.NameplateKey === Plate.toLowerCase())) return true;
    // Opt-in: any recent validate by the leader is enough (if the client never validates the final name)
    return process.env.GUILD_CREATE_ACTIVITY_FALLBACK === "1" && Live.length > 0;
}

// POST /guild {leader_account_id, name, nameplate}. FromGameServer: the leader id comes from the body and
// must have a matching validate ticket; otherwise the caller's own token is the leader.
export async function CreateGuild(Leader: unknown, FromGameServer: boolean, Name: unknown, Nameplate: unknown): Promise<GuildReply> {
    const Now = Date.now();
    const LogRefusal = (Reply: GuildReply, Why: string) => {
        logger.info(`guild: create for ${Shown(Leader)} name=${Quoted(Name)} tag=${Quoted(Nameplate ?? "")} refused ${Describe(Reply)}: ${Why}`);
        return Reply;
    };

    if(!IsAccountIdShape(Leader) || !(await AccountExists(Leader))){
        return LogRefusal(Refuse(400, GUILD_CODE.Unknown, "No such account."), "no such account");
    }

    if(FromGameServer && !HasTicket(Leader, Name, Nameplate, Now)){
        const Rule = CheckNameRules(Name) ?? CheckNameplateRules(Nameplate);
        return LogRefusal(Rule ?? Refuse(403, GUILD_CODE.Unknown, "Check the name in the create window, then try again."), "no validate of this name by the leader in the last 15 minutes");
    }

    const C = await Cols();

    if((await MembershipOf(C, Leader)) !== undefined) return LogRefusal(Refuse(409, GUILD_CODE.AlreadyInAGuild), "already in a guild");

    const Checked = await CheckNameAndNameplate(C, Name, Nameplate);
    if(IsReply(Checked)) return LogRefusal(Checked, "checks");

    const Previous = LastCreated.get(Leader);
    if(Previous !== undefined && Now - Previous < CREATE_INTERVAL_MS){
        return LogRefusal(Refuse(429, GUILD_CODE.Unknown, "A guild was created a moment ago; try again later."), "create interval");
    }

    const GuildId = crypto.randomUUID();
    const At = new Date(Now);

    try{
        await C.Guilds.insertOne({ _id: GuildId, name: Checked.Name, nameKey: Checked.NameKey, nameplate: Checked.Plate, ...(Checked.PlateKey ? { nameplateKey: Checked.PlateKey } : {}), leaderId: Leader, createdAt: At });
    }
    catch(error){
        if(!IsDuplicateKey(error)) throw error;
        return LogRefusal(Refuse(409, GUILD_CODE.NameTaken), "name or nameplate taken in between");
    }

    try{
        await C.Members.insertOne({ _id: Leader, guildId: GuildId, rank: "Leader", joinedAt: At });
    }
    catch(error){
        await C.Guilds.deleteOne({ _id: GuildId });
        if(!IsDuplicateKey(error)) throw error;
        return LogRefusal(Refuse(409, GUILD_CODE.AlreadyInAGuild), "joined a guild in between");
    }

    await C.Invites.deleteMany({ inviteeId: Leader });
    LastCreated.set(Leader, Now);
    Tickets.delete(Leader);
    logger.info(`guild: created G=${GuildId} name=${Checked.Name} tag=${Checked.Plate} leader=${Leader} (${FromGameServer ? "game server" : "client"})`);
    return WithPayload((await GuildData(C, GuildId))!);
}

// ---- Membership ----

async function RemoveGuild(C: C, GuildId: string){
    await C.Members.deleteMany({ guildId: GuildId });
    await C.Invites.deleteMany({ guildId: GuildId });
    await C.Guilds.deleteOne({ _id: GuildId });
}

// DELETE /guild/:guildId: the leader disbands their own guild
export async function DisbandGuild(UserId: string, GuildId: string): Promise<GuildReply> {
    const C = await Cols();
    const M = await MembershipOf(C, UserId);
    const Result = M === undefined || M.guildId !== GuildId ? Refuse(404, GUILD_CODE.NotInAGuild)
        : M.rank !== "Leader" ? Refuse(403, GUILD_CODE.InvalidPermission)
        : (await RemoveGuild(C, GuildId), Ack());
    logger.info(`guild: disband G=${GuildId.slice(0, 64)} by=${UserId} -> ${Describe(Result)}`);
    return Result;
}

// PUT /guild/invite/:accountId: a Leader or Officer invites a player
export async function InviteToGuild(UserId: string, TargetId: string): Promise<GuildReply> {
    const C = await Cols();
    const Now = Date.now();
    let Why = "";

    const Decide = async (): Promise<GuildReply> => {
        const M = await MembershipOf(C, UserId);
        if(M === undefined) return Refuse(404, GUILD_CODE.NotInAGuild);
        if(M.rank !== "Leader" && M.rank !== "Officer") return Refuse(403, GUILD_CODE.InvalidPermission);
        if(!IsAccountIdShape(TargetId) || !(await AccountExists(TargetId))) return Refuse(404, GUILD_CODE.Unknown, "No such account.");

        const Target = await MembershipOf(C, TargetId);
        if(TargetId === UserId || Target?.guildId === M.guildId) return Refuse(409, GUILD_CODE.TargetAlreadyInYourGuild);
        if(await IsBlockedEitherWay(UserId, TargetId)){ Why = "blocked"; return Refuse(403, GUILD_CODE.Unknown, "The invite could not be sent."); }
        if(await C.Members.countDocuments({ guildId: M.guildId }) >= MaxGuildMembers()) return Refuse(409, GUILD_CODE.GuildIsFull);

        const Live = { $gt: new Date(Now) };
        if(await C.Invites.findOne({ guildId: M.guildId, inviteeId: TargetId, expiresAt: Live })) return Refuse(409, GUILD_CODE.TargetAlreadyHasGuildInvite);

        const DeclinedAt = Declined.get(`${M.guildId}|${TargetId}`);
        if(DeclinedAt !== undefined && Now - DeclinedAt < DECLINE_COOLDOWN_MS){
            Why = "declined this guild's invite in the last 24 hours";
            return Refuse(429, GUILD_CODE.Unknown, "That player turned down an invite from this guild recently; try again later.");
        }
        if(await C.Invites.countDocuments({ guildId: M.guildId, expiresAt: Live }) >= MAX_OPEN_INVITES_PER_GUILD) return Refuse(429, GUILD_CODE.Unknown, "Too many open invites for this guild.");
        if(RecentInvitesBy(UserId, Now).length >= MAX_INVITES_PER_INVITER_PER_HOUR) return Refuse(429, GUILD_CODE.Unknown, "Too many guild invites sent in the last hour; try again later.");

        // An expired invite for the same pair gives way; the invitee keeps at most the newest 20
        await C.Invites.deleteMany({ guildId: M.guildId, inviteeId: TargetId });
        const Pending = await C.Invites.find({ inviteeId: TargetId, expiresAt: Live }, { projection: { _id: 1 } }).sort({ createdAt: 1, _id: 1 }).toArray();
        const Drop = Pending.slice(0, Math.max(0, Pending.length - (MAX_OPEN_INVITES_PER_INVITEE - 1))).map((P) => P._id);
        if(Drop.length > 0) await C.Invites.deleteMany({ _id: { $in: Drop } });

        await C.Invites.insertOne({ _id: crypto.randomUUID(), guildId: M.guildId, inviteeId: TargetId, inviterId: UserId, createdAt: new Date(Now), expiresAt: new Date(Now + InviteTtlMs()) });
        return Ack();
    };

    const Result = await Decide();
    if(Result.Status === 200) InvitesSent.set(UserId, [...RecentInvitesBy(UserId, Now), Now]);
    logger.info(`guild: invite by=${UserId} to=${Shown(TargetId)} -> ${Describe(Result)}${Why !== "" ? `: ${Why}` : ""}`);
    return Result;
}

// POST /guild/invite/accept/:guild_invite_id: join as a Member; every other invite of the caller goes
export async function AcceptGuildInvite(UserId: string, InviteId: string): Promise<GuildReply> {
    const C = await Cols();
    let Why = "";

    const Decide = async (): Promise<GuildReply> => {
        const Invite = await C.Invites.findOne({ _id: InviteId });
        if(Invite === null || Invite.inviteeId !== UserId || Invite.expiresAt <= new Date()) return Refuse(404, GUILD_CODE.InviteNotFound);
        if((await MembershipOf(C, UserId)) !== undefined) return Refuse(409, GUILD_CODE.AlreadyInAGuild, "You need to leave your guild before accepting another guild invite.");

        Why = !(await C.Guilds.findOne({ _id: Invite.guildId }, { projection: { _id: 1 } })) ? "the guild is gone"
            : await IsBlockedEitherWay(UserId, Invite.inviterId) ? "blocked"
            : !(await InviterStillMayInvite(C, Invite.inviterId, Invite.guildId)) ? "the inviter may no longer invite"
            : "";
        if(Why !== ""){
            await C.Invites.deleteOne({ _id: Invite._id });
            return Refuse(404, GUILD_CODE.InviteNotFound);
        }
        if(await C.Members.countDocuments({ guildId: Invite.guildId }) >= MaxGuildMembers()) return Refuse(409, GUILD_CODE.GuildIsFull);

        try{
            await C.Members.insertOne({ _id: UserId, guildId: Invite.guildId, rank: "Member", joinedAt: new Date() });
        }
        catch(error){
            if(!IsDuplicateKey(error)) throw error;
            return Refuse(409, GUILD_CODE.AlreadyInAGuild, "You need to leave your guild before accepting another guild invite.");
        }
        await C.Invites.deleteMany({ inviteeId: UserId });
        Why = `G=${Invite.guildId}`;
        return Ack();
    };

    const Result = await Decide();
    logger.info(`guild: accept by=${UserId} -> ${Describe(Result)}${Why !== "" ? `: ${Why}` : ""}`);
    return Result;
}

// DELETE /guild/invite/:guild_invite_id: the invitee declines; that guild cannot re-invite them for 24 hours
export async function DeclineGuildInvite(UserId: string, InviteId: string): Promise<GuildReply> {
    const C = await Cols();
    const Invite = await C.Invites.findOne({ _id: InviteId });
    let Result: GuildReply;

    if(Invite === null || Invite.inviteeId !== UserId){
        Result = Refuse(404, GUILD_CODE.InviteNotFound);
    }
    else{
        await C.Invites.deleteOne({ _id: Invite._id });
        if(Invite.expiresAt > new Date()) Declined.set(`${Invite.guildId}|${UserId}`, Date.now());
        Result = Ack();
    }

    logger.info(`guild: decline by=${UserId} -> ${Describe(Result)}`);
    return Result;
}

async function Leave(C: C, UserId: string, M: MemberDoc): Promise<GuildReply> {
    if(M.rank === "Leader") return Refuse(409, GUILD_CODE.LeaderCannotLeave);
    await C.Members.deleteOne({ _id: UserId });
    await C.Invites.deleteMany({ guildId: M.guildId, inviterId: UserId });
    return Ack();
}

// DELETE /guild/player: a Member or Officer leaves (the leader disbands or hands over first)
export async function LeaveGuild(UserId: string): Promise<GuildReply> {
    const C = await Cols();
    const M = await MembershipOf(C, UserId);
    const Result = M === undefined ? Refuse(404, GUILD_CODE.NotInAGuild) : await Leave(C, UserId, M);
    logger.info(`guild: leave by=${UserId} -> ${Describe(Result)}`);
    return Result;
}

// DELETE /guild/player/:accountId: the leader removes a member (naming oneself is a leave)
export async function KickGuildMember(UserId: string, TargetId: string): Promise<GuildReply> {
    const C = await Cols();

    const Decide = async (): Promise<GuildReply> => {
        const M = await MembershipOf(C, UserId);
        if(M === undefined) return Refuse(404, GUILD_CODE.NotInAGuild);
        if(TargetId === UserId) return Leave(C, UserId, M);
        if(M.rank !== "Leader") return Refuse(403, GUILD_CODE.InvalidPermission);

        const Target = IsAccountIdShape(TargetId) ? await MembershipOf(C, TargetId) : undefined;
        if(Target === undefined || Target.guildId !== M.guildId) return Refuse(404, GUILD_CODE.NotInAGuild);

        await C.Members.deleteOne({ _id: Target._id });
        await C.Invites.deleteMany({ guildId: M.guildId, inviterId: Target._id });
        return Ack();
    };

    const Result = await Decide();
    logger.info(`guild: kick by=${UserId} target=${Shown(TargetId)} -> ${Describe(Result)}`);
    return Result;
}

// PUT /guild/rank/:accountId/:rank (member|officer|leader, any case): leader only. Making someone leader
// hands the guild over; the old leader becomes an Officer.
export async function ChangeGuildRank(UserId: string, TargetId: string, RankValue: string): Promise<GuildReply> {
    const C = await Cols();

    const Decide = async (): Promise<GuildReply> => {
        const M = await MembershipOf(C, UserId);
        if(M === undefined) return Refuse(404, GUILD_CODE.NotInAGuild);
        if(M.rank !== "Leader") return Refuse(403, GUILD_CODE.InvalidPermission);

        const Rank = NormalizeRank(RankValue);
        if(Rank === undefined) return Refuse(400, GUILD_CODE.InvalidRank);

        const Target = IsAccountIdShape(TargetId) ? await MembershipOf(C, TargetId) : undefined;
        if(Target === undefined || Target.guildId !== M.guildId) return Refuse(404, GUILD_CODE.NotInAGuild);
        if(Target._id === UserId) return Refuse(403, GUILD_CODE.InvalidPermission);
        if(Target.rank === Rank) return Ack();

        await C.Members.updateOne({ _id: Target._id }, { $set: { rank: Rank } });
        // A Member may not invite: the invites they sent as an Officer go
        if(Rank === "Member") await C.Invites.deleteMany({ guildId: M.guildId, inviterId: Target._id });
        if(Rank === "Leader"){
            await C.Members.updateOne({ _id: UserId }, { $set: { rank: "Officer" } });
            await C.Guilds.updateOne({ _id: M.guildId }, { $set: { leaderId: Target._id } });
        }
        return Ack();
    };

    const Result = await Decide();
    logger.info(`guild: rank by=${UserId} target=${Shown(TargetId)} rank=${Quoted(RankValue)} -> ${Describe(Result)}`);
    return Result;
}

// XMPP (realtime/RoomService.ts): whether this account may join the room Guild-<GuildId>
export async function IsGuildMember(AccountId: string, GuildId: string): Promise<boolean> {
    const C = await Cols();
    return (await MembershipOf(C, AccountId))?.guildId === GuildId;
}
