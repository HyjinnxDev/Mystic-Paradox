// Staff tiers for the /admin dashboard. "owner" is granted only by scripts/bootstrap_admin.ts
// (never through the API); owners also hold "admin" so older roles.includes("admin") checks
// (Discord admin sign-in, launcher policy) keep working.
const RANK: Record<string, number> = { moderator: 1, admin: 2, owner: 3 };

export type StaffPermission =
    | "players.read"        // player list, online list, audit log
    | "players.ban.timed"   // timed ban up to MODERATOR_MAX_BAN_HOURS
    | "players.access"      // permanent ban, disable, unban, approve/reject sign-ups
    | "players.roles"       // grant/revoke moderator, admin, tester
    | "players.delete"
    | "operations";

const MIN_RANK: Record<StaffPermission, number> = {
    "players.read": 1,
    "players.ban.timed": 1,
    "players.access": 2,
    "players.roles": 3,
    "players.delete": 3,
    "operations": 3
};

export const MODERATOR_MAX_BAN_HOURS = 7 * 24;

export function StaffRank(roles: readonly string[]): number {
    return Math.max(0, ...roles.map((Role) => RANK[Role] ?? 0));
}

export function HasStaffPermission(roles: readonly string[], permission: StaffPermission): boolean {
    return StaffRank(roles) >= MIN_RANK[permission];
}

/** Prefix the game shows before staff names (nameplate, chat, party). The client DLL styles
 *  nameplates by it (MysticParadox.dll, StaffNameplates), so keep the two in step. */
export function StaffNameTag(roles: readonly string[]): string {
    const Rank = StaffRank(roles);
    return ["", "[Mod] ", "[Admin] ", "[Owner] "][Rank];
}

/** Strips a StaffNameTag so a name the game echoes back still finds the account. */
export const StripStaffNameTag = (name: string): string => name.replace(/^\[(Owner|Admin|Mod)\]\s*/i, "");

/** Staff may only act on accounts ranked strictly below them (a moderator can't ban an admin). */
export function CanActOn(actorRoles: readonly string[], targetRoles: readonly string[]): boolean {
    return StaffRank(actorRoles) > StaffRank(targetRoles);
}
